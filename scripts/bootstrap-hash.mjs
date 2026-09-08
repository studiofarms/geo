import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {passwordHash} from '../src/server/platform/core.mjs';

// Only the salted scrypt hash is printed. Plaintext is neither saved nor echoed.
let password;
if(process.stdin.isTTY){
  let muted=false;
  const output=new Writable({write(chunk,encoding,callback){if(!muted)process.stderr.write(chunk,encoding);callback();}});
  const prompt=createInterface({input:process.stdin,output,terminal:true});
  process.stderr.write('Initial coach password (12+ characters, hidden): ');muted=true;
  password=await prompt.question('');process.stderr.write('\n');
  const repeated=await (process.stderr.write('Confirm password (hidden): '),prompt.question(''));process.stderr.write('\n');prompt.close();
  if(password!==repeated)throw new Error('Passwords do not match.');
}else{
  const parts=[];for await(const chunk of process.stdin)parts.push(chunk);
  password=Buffer.concat(parts).toString('utf8').replace(/\r?\n$/,'');
}
if(password.length<12||password.length>256)throw new Error('Use a password between 12 and 256 characters.');
console.log(passwordHash(password));
