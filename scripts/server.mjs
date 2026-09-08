import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { createApp } from '../src/server/http.mjs';
import { createDatabaseStore } from '../src/server/postgres/runtime.mjs';
import { createNetlifyHandler } from '../src/server/netlify/handler.mjs';
import { Calendly } from '../src/server/calendly/service.mjs';
import { Zoom } from '../src/server/zoom/service.mjs';
import { runReminders } from '../src/server/platform/operations.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const production = process.argv.includes('--production');
const root = resolve(project, production ? 'dist' : 'src');
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port number.');
await access(resolve(root, 'index.html')).catch(() => { throw new Error('Run npm --prefix config run build before starting production.'); });
const database=process.env.DATABASE_URL||process.env.PGDATABASE;
const store=database?await createDatabaseStore():null;
const origins=[`http://localhost:${port}`,`http://127.0.0.1:${port}`,`http://[::1]:${port}`,...(process.env.PUBLIC_ORIGIN?[new URL(process.env.PUBLIC_ORIGIN).origin]:[])];
const calendly=store?new Calendly({store,secretKey:process.env.GOCOACH_SECRET_KEY,origin:process.env.PUBLIC_ORIGIN}):null;
const zoom=store?new Zoom({store,secretKey:process.env.GOCOACH_SECRET_KEY}):null;
const apiHandler=store?createNetlifyHandler({store,demo:store.demo,origins,calendly,zoom}):null;
const reminderTimer=store?setInterval(()=>store.run(db=>runReminders(db),true).catch(error=>console.error('Reminder processing failed:',error.code||error.name)),300000).unref():null;
const server = createApp({ root, development: !production,
  apiHandler,
  dataDirectory: process.env.DATA_DIR || resolve(project, 'data/inquiries'),
  platformDirectory: process.env.PLATFORM_DATA_DIR,
  publicOrigin: process.env.PUBLIC_ORIGIN,
});
server.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`GoCoach ${production ? 'production' : 'development'} server\nLocal: http://localhost:${port}\nWorkspace: http://localhost:${port}/portal.html\nDiscovery booking: http://localhost:${port}/book.html\nStorage: ${store?'PostgreSQL. Configure Calendly in coach Settings.':'local JSON. External providers are not connected.'}\n${store?store.demo?'Public demo access is enabled.':'Coach sign-in is required.':production?'Provision a coach with npm run create-coach.':'Coach, buyer, and participant demo accounts are available.'}`);
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
server.on('close',()=>{clearInterval(reminderTimer);store?.pool.end();});
