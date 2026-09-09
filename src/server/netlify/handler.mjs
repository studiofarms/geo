import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createPlatform } from '../platform/router.mjs';
import { RequestError,validateInquiry } from '../inquiries.mjs';
const headers={
  'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'strict-origin-when-cross-origin',
  'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",
};
/** @param {Request} request @param {number} maximum @returns {Promise<Buffer>} */
async function readLimited(request,maximum){
  if(Number(request.headers.get('content-length'))>maximum)throw new RequestError(413,'Request is too large.');
  const parts=[];let size=0;
  if(request.body)for await(const chunk of request.body){size+=chunk.length;if(size>maximum)throw new RequestError(413,'Request is too large.');parts.push(Buffer.from(chunk));}
  return Buffer.concat(parts);
}
/** Adapt the existing API to Netlify's Web Request/Response contract.
 * @param {{store:any,demo:boolean,origins:string[],calendly?:any}} options
 * @returns {(request:Request,context?:{ip?:string})=>Promise<Response>} */
export function createNetlifyHandler({store,demo,origins,calendly,zoom}){
  const platform=createPlatform({store,development:demo,timers:false,calendly,zoom});
  return async(request,context={})=>{
    try{
      const url=new URL(request.url);
      if(!origins.includes(url.origin))throw new RequestError(403,'This host is not allowed.');
      if(url.pathname==='/api/webhooks/calendly'){
        if(request.method!=='POST')return new Response(null,{status:405,headers:{...headers,Allow:'POST'}});
        if(!calendly)throw new RequestError(503,'Calendly is not configured.');
        const raw=await readLimited(request,256*1024);
        const result=await calendly.receiveWebhook(raw,request.headers.get('calendly-webhook-signature'));
        return Response.json(result,{headers});
      }
      if(request.method==='POST'&&((request.headers.has('origin')&&!origins.includes(request.headers.get('origin')))||request.headers.get('sec-fetch-site')==='cross-site'))throw new RequestError(403,'Submit from the GoCoach website.');
      if(url.pathname==='/api/health'){
        if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers:{...headers,Allow:'GET, HEAD'}});
        // Report an unhealthy deployment as one of a fixed set of codes. Only these
        // known configuration states are named; no error text is ever echoed back.
        try{await store.run(()=>null);}
        catch(error){
          const setup=typeof error?.setup==='string'?error.setup:'unavailable';
          console.error('GoCoach health check failed:',setup,'-',error.message);
          return request.method==='HEAD'?new Response(null,{status:503,headers}):Response.json({status:'error',setup},{status:503,headers});
        }
        return request.method==='HEAD'?new Response(null,{headers}):Response.json({status:'ok',mode:demo?'demo':'production',storage:'postgres',inquiryDelivery:'database'},{headers});
      }
      if(url.pathname==='/api/inquiries'){
        if(request.method!=='POST')return new Response(null,{status:405,headers:{...headers,Allow:'POST'}});
        await store.takeRate(`inquiry:${context.ip||'unknown'}`,10,900);
        const raw=await readLimited(request,16384),type=request.headers.get('content-type')?.split(';')[0];
        let body;
        if(type==='application/x-www-form-urlencoded')body=Object.fromEntries(new URLSearchParams(raw.toString()));
        else if(type==='application/json'){try{body=JSON.parse(raw.toString());}catch{throw new RequestError(400,'Invalid JSON.');}}
        else throw new RequestError(415,'Submit the inquiry form on this website.');
        if(body?.website)throw new RequestError(422,'Please leave the website field empty.');
        const receipt=await store.saveInquiry(validateInquiry(body),request.headers.get('idempotency-key')||body.requestId||randomUUID());
        if(type==='application/x-www-form-urlencoded')return new Response(null,{status:303,headers:{...headers,Location:'/inquiry-received.html'}});
        return Response.json({...receipt,delivery:'database',message:'Your inquiry has been saved. No email has been sent.'},{status:receipt.duplicate?200:201,headers});
      }
      const raw=await readLimited(request,4.5*1024*1024),req=Readable.from(raw.length?[raw]:[]);
      Object.assign(req,{method:request.method,headers:Object.fromEntries(request.headers),socket:{remoteAddress:context.ip||'unknown'}});
      const responseHeaders=new Headers(headers);let status=200,body=null;
      const res={setHeader(name,value){responseHeaders.set(name,String(value));},writeHead(code,values){status=code;for(const[k,v]of Object.entries(values||{}))responseHeaders.set(k,String(v));},end(value){body=value??null;}};
      if(!await platform.handle(req,res,url,origins))throw new RequestError(404,'Endpoint not found.');
      return new Response(body,{status,headers:responseHeaders});
    }catch(error){
      const status=error instanceof RequestError?error.status:503;
      if(status===503)console.error('GoCoach API unavailable:',error.code||error.name,'-',error.message);
      return Response.json({error:status===503?'The service is temporarily unavailable. Please try again shortly.':error.message,fields:error.fields||{}},{status,headers:{...headers,...(status===429?{'Retry-After':'60'}:{})}});
    }
  };
}
