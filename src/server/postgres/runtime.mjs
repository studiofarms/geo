import { PostgresStore } from './store.mjs';
export const DEFAULT_WORKSPACE='c63f1ea0-e2a4-4e03-a964-d2bedbce3b11';
/** @param {NodeJS.ProcessEnv} env @returns {Promise<PostgresStore>} */
export async function createDatabaseStore(env=process.env) {
  let pool;
  if(env.DATABASE_URL && !env.NETLIFY){const {default:pg}=await import('pg');pool=new pg.Pool({connectionString:env.DATABASE_URL,max:3,connectionTimeoutMillis:10000,idleTimeoutMillis:10000,allowExitOnIdle:true});}
  else if(env.NETLIFY || env.NETLIFY_DEV || env.NETLIFY_DATABASE_URL){const {getDatabase}=await import('@netlify/database');pool=getDatabase().pool;}
  else if(env.PGDATABASE){const {default:pg}=await import('pg');pool=new pg.Pool({max:3,allowExitOnIdle:true});}
  else throw new Error('PostgreSQL is not configured');
  const demo=env.GOCOACH_DEMO==='true';
  const bootstrap=env.GOCOACH_BOOTSTRAP_EMAIL&&env.GOCOACH_BOOTSTRAP_PASSWORD_HASH?{email:env.GOCOACH_BOOTSTRAP_EMAIL,name:env.GOCOACH_BOOTSTRAP_NAME||'Coach',passwordHash:env.GOCOACH_BOOTSTRAP_PASSWORD_HASH}:undefined;
  return new PostgresStore({pool,workspaceId:env.GOCOACH_WORKSPACE_ID||DEFAULT_WORKSPACE,demo,bootstrap});
}
