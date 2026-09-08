import {createCipheriv,createDecipheriv,randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {fail} from '../platform/core.mjs';
/** @param {string} key @returns {Buffer} */
function encryptionKey(key){if(!/^[a-f\d]{64}$/i.test(key||''))fail(503,'Set GOCOACH_SECRET_KEY in the server environment to securely connect integrations.');return Buffer.from(key,'hex');}
/** @param {string} value @param {string} key @param {string} context @returns {string} */
export function encrypt(value,key,context){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(key),iv);cipher.setAAD(Buffer.from(context));const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),data.toString('base64')].join('.');}
/** @param {string} value @param {string} key @param {string} context @returns {string} */
export function decrypt(value,key,context){const [version,iv,tag,data]=value.split('.');if(version!=='v1')throw new Error('Unsupported secret format');const cipher=createDecipheriv('aes-256-gcm',encryptionKey(key),Buffer.from(iv,'base64'));cipher.setAAD(Buffer.from(context));cipher.setAuthTag(Buffer.from(tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('utf8');}
/** @param {Buffer} raw @param {string|null} signature @param {string} key @param {number} now @returns {boolean} */
export function verifySignature(raw,signature,key,now=Date.now()){
  const parts=(signature||'').split(',').map(p=>p.trim().split('=')),timestamp=parts.find(([k])=>k==='t')?.[1];
  if(!/^\d+$/.test(timestamp||'')||Math.abs(now/1000-Number(timestamp))>180)return false;
  const expected=createHmac('sha256',key).update(`${timestamp}.`).update(raw).digest();
  return parts.filter(([k,v])=>k==='v1'&&/^[a-f\d]{64}$/i.test(v)).some(([,v])=>timingSafeEqual(expected,Buffer.from(v,'hex')));
}
/** @param {unknown} input @param {boolean} optional @returns {string} */
export function bookingURL(input,optional=false){if(optional&&!input)return '';try{const u=new URL(String(input));if(u.origin!=='https://calendly.com'||u.username||u.password||!/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/?$/.test(u.pathname))throw new Error();u.search='';u.hash='';return u.href.replace(/\/$/,'');}catch{fail(422,'Use a Calendly event link such as https://calendly.com/your-name/discovery.');}}
/** @param {string} uri @param {string} resource @returns {string} */
export function apiURI(uri,resource){const pattern=new RegExp(`^https://api[.]calendly[.]com/${resource}/[A-Za-z0-9-]+$`);if(!pattern.test(uri||''))fail(422,'Invalid Calendly resource.');return uri;}
