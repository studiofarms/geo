import { PostgresStore } from './store.mjs';
export const DEFAULT_WORKSPACE='c63f1ea0-e2a4-4e03-a964-d2bedbce3b11';
/** @param {NodeJS.ProcessEnv} env @returns {Promise<PostgresStore>} */
export async function createDatabaseStore(env=process.env) {
  let pool;
  if(env.DATABASE_URL && !env.NETLIFY){const {default:pg}=await import('pg');pool=new pg.Pool({connectionString:env.DATABASE_URL,max:3,connectionTimeoutMillis:10000,idleTimeoutMillis:10000,allowExitOnIdle:true});}
  else if(env.NETLIFY || env.NETLIFY_DEV || env.NETLIFY_DB_URL || env.NETLIFY_DATABASE_URL){
    // The SDK reads NETLIFY_DB_URL; Netlify has also provisioned the connection as
    // NETLIFY_DATABASE_URL. Pass whichever exists so either name works.
    const {getDatabase}=await import('@netlify/database');
    const connectionString=env.NETLIFY_DB_URL||env.NETLIFY_DATABASE_URL;
    pool=getDatabase(connectionString?{connectionString}:{}).pool;
  }
  else if(env.PGDATABASE){const {default:pg}=await import('pg');pool=new pg.Pool({max:3,allowExitOnIdle:true});}
  else throw new Error('PostgreSQL is not configured');
  // Deployment UIs and copy/paste readily leave surrounding whitespace on a value.
  // The password hash, workspace id and demo flag are all matched exactly, so an
  // untrimmed value fails validation for a reason no operator can see.
  const setting=key=>typeof env[key]==='string'?env[key].trim():'';
  const demo=setting('GOCOACH_DEMO')==='true';
  const email=setting('GOCOACH_BOOTSTRAP_EMAIL'),passwordHash=setting('GOCOACH_BOOTSTRAP_PASSWORD_HASH');
  const bootstrap=email&&passwordHash?{email,name:setting('GOCOACH_BOOTSTRAP_NAME')||'Coach',passwordHash}:undefined;
  return new PostgresStore({pool,workspaceId:setting('GOCOACH_WORKSPACE_ID')||DEFAULT_WORKSPACE,demo,bootstrap});
}
