import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac} from 'node:crypto';
import {encrypt,decrypt,verifySignature,bookingURL} from '../src/server/calendly/security.mjs';
import {calendlySettings} from '../src/platform/calendly.js';
import {app} from '../src/platform/ui.js';
test('Calendly secrets authenticate their workspace and reject tampering',()=>{
  const key=randomBytes(32).toString('hex'),value=encrypt('fake test token',key,'workspace:token');
  assert.equal(decrypt(value,key,'workspace:token'),'fake test token');
  assert.throws(()=>decrypt(value,key,'other-workspace:token'));assert.throws(()=>decrypt(value.slice(0,-4)+'AAAA',key,'workspace:token'));
});
test('Calendly webhook verification checks raw bytes, timestamp, and rotating signatures',()=>{
  const raw=Buffer.from('{"payload":"test"}'),key='test-signing-key',t=Math.floor(Date.now()/1000),signature=createHmac('sha256',key).update(`${t}.`).update(raw).digest('hex');
  assert.equal(verifySignature(raw,`t=${t},v1=${'0'.repeat(64)},v1=${signature}`,key),true);
  assert.equal(verifySignature(Buffer.from('{}'),`t=${t},v1=${signature}`,key),false);
  assert.equal(verifySignature(raw,`t=${t},v1=${signature}`,key,(t+181)*1000),false);
  for(const value of ['https://calendly.com.evil.test/coach/discovery','http://calendly.com/coach/discovery','https://evil@calendly.com/coach/discovery','javascript:alert(1)'])assert.throws(()=>bookingURL(value));
  assert.equal(bookingURL('https://calendly.com/coach/discovery?x=y'),'https://calendly.com/coach/discovery');
});
test('Calendly settings escape provider content and never populate the token field',()=>{
  app.data={demo:false,calendly:{available:true,connected:true,tokenConfigured:true,secretStorageReady:true,eventTypes:[{url:'https://calendly.com/coach/discovery',name:'<script>bad</script>',duration:30}],accountName:'<img src=x onerror=alert(1)>'}};
  const html=calendlySettings();assert.ok(html.includes('type="password" value=""'));assert.ok(!html.includes('<script>bad'));assert.ok(html.includes('&lt;img'));assert.ok(html.includes('Save & test connection'));
  app.data=null;
});
