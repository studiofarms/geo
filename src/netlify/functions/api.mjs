import { createDatabaseStore } from '../../server/postgres/runtime.mjs';
import { createNetlifyHandler } from '../../server/netlify/handler.mjs';
import { Calendly } from '../../server/calendly/service.mjs';
import { Zoom } from '../../server/zoom/service.mjs';
let application;
/** @param {Request} request @param {any} context @returns {Promise<Response>} */
export default async function handler(request,context){
  try{
    application ||= (async()=>{
      const store=await createDatabaseStore();
      const origins=[process.env.URL,process.env.DEPLOY_PRIME_URL,process.env.DEPLOY_URL,process.env.PUBLIC_ORIGIN]
        .filter(Boolean).map(value=>new URL(value).origin);
      if(process.env.NETLIFY_DEV)origins.push('http://localhost:8888','http://127.0.0.1:8888');
      const calendly=new Calendly({store,secretKey:process.env.GOCOACH_SECRET_KEY,origin:process.env.PUBLIC_ORIGIN||process.env.URL,
        allowExternalWrites:!process.env.NETLIFY||process.env.CONTEXT==='production'});
      const zoom=new Zoom({store,secretKey:process.env.GOCOACH_SECRET_KEY,allowExternalWrites:!process.env.NETLIFY||process.env.CONTEXT==='production'});
      return createNetlifyHandler({store,demo:store.demo,origins:[...new Set(origins)],calendly,zoom});
    })();
    return await(await application)(request,context);
  }catch(error){application=null;console.error('GoCoach initialization failed:',error.code||error.name);return Response.json({error:'Complete the database and workspace setup to enable this service.'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
export const config={path:'/api/*'};
