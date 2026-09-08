import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/server/platform/store.mjs';
import { id, email, text, passwordHash } from '../src/server/platform/core.mjs';
import { createDatabaseStore } from '../src/server/postgres/runtime.mjs';
const [address, name] = process.argv.slice(2);
if (!address || !name) {
  console.error('Usage: npm --prefix config run create-coach -- coach@example.com "Coach Name"\nCreates a coach in the production data store. Set GOCOACH_PASSWORD to supply a password, or a random one will be generated.');
  process.exitCode = 1;
} else {
  const directory = process.env.PLATFORM_DATA_DIR || fileURLToPath(new URL('../data/platform-production', import.meta.url));
  const database=process.env.DATABASE_URL||process.env.PGDATABASE;
  const store = database?await createDatabaseStore():new Store(directory, false);
  if(database){if(store.demo)throw new Error('Create real accounts in a production workspace.');store.allowEmpty=true;}
  const password = process.env.GOCOACH_PASSWORD || randomBytes(20).toString('base64url');
  await store.run(db => {
    const normalized = email(address);
    if (db.users.some(user => user.email === normalized)) throw new Error('This account already exists. No credentials were changed.');
    db.users.push({ id: id(), name: text(name, 100), email: normalized, role: 'coach', passwordHash: passwordHash(password) });
  }, true);
  console.log('Coach account created in the production store. Restart the production server before signing in.');
  if (!process.env.GOCOACH_PASSWORD) console.log('One-time password display:', password);
  if(database)await store.pool.end();
}
