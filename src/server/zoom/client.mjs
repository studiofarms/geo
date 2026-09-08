import {fail} from '../platform/core.mjs';
/** @param {unknown} value @returns {string} */
export function joinURL(value){try{const u=new URL(String(value));if(u.protocol!=='https:'||u.username||u.password||u.port||!/(^|\.)zoom\.(us|com)$/.test(u.hostname))throw new Error();return u.href;}catch{fail(502,'Zoom returned an invalid meeting link.');}}
export const meetingId=value=>{const id=String(value);if(!/^\d{9,15}$/.test(id))fail(502,'Zoom returned an invalid meeting ID.');return id;};
/** Minimal Zoom REST client. Provider tokens and host start URLs never leave the server. */
export class ZoomClient {
  /** @param {typeof fetch} fetcher */
  constructor(fetcher=fetch){this.fetcher=fetcher;}
  async request(url,options){
    let response;try{response=await this.fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(12000)});}catch{fail(502,'Zoom could not be reached. Retry to check the previous request.');}
    if(!response.ok){
      const status=response.status;
      if([400,401,403].includes(status))fail(422,'Zoom rejected this request. Check the app is active, its credentials and scopes, and the host account permissions.');
      if(status===404)fail(404,'This Zoom host or meeting could not be found.');
      if(status===429)fail(429,'Zoom is busy. Wait a moment and try again.');
      fail(502,'Zoom could not complete this request. Retry to check its status.');
    }
    if(response.status===204)return {};
    try{return await response.json();}catch{fail(502,'Zoom returned an incomplete response. Retry to check its status.');}
  }
  /** @param {{accountId:string,clientId:string,clientSecret:string}} credentials */
  async token(credentials){
    const result=await this.request('https://zoom.us/oauth/token',{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'account_credentials',account_id:credentials.accountId}).toString()});
    if(!result.access_token)fail(422,'Zoom did not grant an access token. Check the app activation.');return result.access_token;
  }
  async api(path,token,method='GET',body){
    if(!path.startsWith('/')||path.startsWith('//'))fail(422,'Invalid Zoom API path.');
    return this.request(`https://api.zoom.us/v2${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  }
  async findMeeting(hostId,reference,token){
    let page;
    for(let count=0;count<10;count++){
      const result=await this.api(`/users/${encodeURIComponent(hostId)}/meetings?type=scheduled&page_size=300${page?`&next_page_token=${encodeURIComponent(page)}`:''}`,token);
      const matches=(result.meetings||[]).filter(m=>m.agenda===reference);
      if(matches.length>1)fail(409,'More than one matching meeting exists. Review these meetings in Zoom.');
      if(matches.length)return this.api(`/meetings/${meetingId(matches[0].id)}`,token);
      page=result.next_page_token;if(!page)return null;
    }
    fail(409,'Too many Zoom meetings to check safely. Review the earlier attempt in Zoom.');
  }
}
