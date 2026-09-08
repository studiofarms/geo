import test from 'node:test';
import assert from 'node:assert/strict';
import {joinURL} from '../src/server/zoom/client.mjs';
import {zoomSettings,zoomSessionActions} from '../src/platform/zoom.js';
import {app} from '../src/platform/ui.js';
test('Zoom join URLs accept Zoom regions and reject injected or unrelated hosts',()=>{
  assert.equal(joinURL('https://us02web.zoom.us/j/12345678901'),'https://us02web.zoom.us/j/12345678901');
  for(const value of ['https://zoom.us.attacker.test/j/123','https://attacker@zoom.us/j/123','http://zoom.us/j/123','https://zoom.us:8000/j/123','javascript:alert(1)'])assert.throws(()=>joinURL(value));
});
test('Zoom setup guides code-free connection while hiding the stored secret',()=>{
  app.data={user:{role:'coach'},demo:false,zoom:{available:true,connected:true,operationsAllowed:true,secretConfigured:true,hostName:'<script>bad</script>',meetings:[]}};
  const html=zoomSettings();assert.ok(html.includes('Server-to-Server OAuth'));assert.ok(html.includes('type="password" value=""'));assert.ok(!html.includes('<script>bad'));
  assert.ok(zoomSessionActions({id:'s',status:'scheduled'}).includes('Create Zoom meeting'));assert.equal(zoomSessionActions({id:'s',provider:'calendly'}),'');app.data=null;
});
