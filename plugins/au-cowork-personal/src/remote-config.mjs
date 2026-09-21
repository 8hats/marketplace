import fs from 'node:fs';
import path from 'node:path';
import { OursClient } from '@ours.network/sdk/client';

const messages={
 daemon_setup_required:'Cannot connect to the local ours daemon. For a remote daemon, create .au-ours.json in this project with url and tokenFile pointing to your private local token file (mode 600), or set AU_OURS_URL and AU_OURS_API_TOKEN together in the MCP server environment. If using a local daemon, ask its operator to check its configuration, credentials and service. No invitation was submitted by this attempt. After correcting project configuration, retry connect_to_room in this session; environment changes require an MCP restart.',
 remote_configuration:'Configure AU_OURS_URL and AU_OURS_API_TOKEN together, or a project .au-ours.json with url and protected tokenFile. Use HTTPS (HTTP only for literal loopback), without credentials, query or fragment.',
 remote_authentication:'The remote daemon rejected authentication. Check the selected API token with its operator.',
 remote_unavailable:'Cannot reach the remote daemon. Check its address, TLS trust, SSH tunnel and service health.',
 remote_unsupported:'This remote daemon has not been verified for external sessions. Use daemon 3.8.1-nightly.1; do not use a local PID lease across hosts.',
 remote_request:'The remote daemon could not complete the request. Check daemon health and the operation inputs; server details were withheld.',
};
export const remoteError=code=>Object.assign(new Error(messages[code]),{code});
export const remoteDiagnostic=error=>Object.hasOwn(messages,error?.code??'')?{code:error.code,message:messages[error.code]}:null;
const invalid=()=>remoteError('remote_configuration');
function address(value){
 if(typeof value!=='string'||!value||value!==value.trim()||/[\\\s?#]/.test(value)||/%(?:2e|2f|5c)/i.test(value))throw invalid();
 let url;try{url=new URL(value);}catch{throw invalid();}
 if(url.username||url.password||!['https:','http:'].includes(url.protocol))throw invalid();
 const authority=value.match(/^https?:\/\/([^/]+)/)?.[1];
 if(url.protocol==='http:'&&!/^(?:127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(authority??''))throw invalid();
 return url.href.replace(/\/+$/,'');
}
function tokenValue(value){if(typeof value!=='string'||!value||/\s/.test(value)||value.length>8192)throw invalid();return value;}
function readToken(file){
 let fd;try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const stat=fs.fstatSync(fd);
  if(!stat.isFile()||(stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid())||stat.size>8192)throw invalid();
  return tokenValue(fs.readFileSync(fd,'utf8').trim());
 }catch{throw invalid();}finally{if(fd!==undefined)fs.closeSync(fd);}
}
/** Remote credentials are closures, deliberately absent from JSON diagnostics. */
export function resolveRemoteConfig({env=process.env,cwd=process.cwd()}={}){
 if(env.AU_OURS_URL!==undefined||env.AU_OURS_API_TOKEN!==undefined){
  const url=address(env.AU_OURS_URL),value=tokenValue(env.AU_OURS_API_TOKEN);
  return {url,source:'environment',token:()=>value};
 }
 const file=path.resolve(cwd,env.AU_OURS_CONFIG??'.au-ours.json');let config;
 try{
  const stat=fs.statSync(file);if(!stat.isFile()||stat.size>16384)throw invalid();
  config=JSON.parse(fs.readFileSync(file,'utf8'));
 }catch(error){if(error.code==='ENOENT'&&env.AU_OURS_CONFIG===undefined)return null;throw invalid();}
 if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).sort().join(',')!=='tokenFile,url'||typeof config.tokenFile!=='string'||!config.tokenFile.trim())throw invalid();
 const url=address(config.url),tokenFile=path.resolve(path.dirname(file),config.tokenFile);
 readToken(tokenFile);
 return {url,source:'project',token:()=>readToken(tokenFile)};
}
export function remoteTransport(base,fetchImpl=globalThis.fetch){
 const selected=new URL(base);
 return async(input,options={})=>{
  let url;try{url=new URL(String(input));}catch{throw invalid();}
  if(url.origin!==selected.origin||url.username||url.password||url.hash||!(url.pathname===selected.pathname||url.pathname.startsWith(selected.pathname.replace(/\/$/,'')+'/')))throw invalid();
  let response;
  try{response=await fetchImpl(url.href,{...options,redirect:'error'});}catch{throw remoteError('remote_unavailable');}
  if(response.status===401||response.status===403){await response.body?.cancel();throw remoteError('remote_authentication');}
  if(response.status>=300&&response.status<400){await response.body?.cancel();throw remoteError('remote_unavailable');}
  return response;
 };
}
/** Expert SDK transport adapter: TLS/SSH authenticates the explicit endpoint.
 * No local state discovery and no claimed instance-ID verification. The exact
 * daemon release is allowlisted until external-session conformance is re-tested.
 */
export async function attachRemote(selection,{leaseToken,fetch:fetchImpl=globalThis.fetch}={}){
 const transport=remoteTransport(selection.url,fetchImpl);
 const fetch=async(input,options={})=>transport(input,{...options,headers:{...options.headers,'x-ours-api-token':selection.token()}});
 let info;
 try{
  const response=await fetch(selection.url+'/info',{signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw remoteError('remote_unavailable');
  const body=await response.text();if(body.length>16384)throw remoteError('remote_unsupported');info=JSON.parse(body);
 }catch(error){throw messages[error.code]?error:remoteError('remote_unavailable');}
 if(info?.name!=='ours'||info.version!=='3.8.1-nightly.1')throw remoteError('remote_unsupported');
 const client=new OursClient({url:selection.url,leaseToken,sessionMode:'external',fetch});
 // SDK error bodies may be controlled by a proxy/server. Keep codes for existing
 // tool mappings, but never expose raw server prose (which could echo secrets).
 return new Proxy(client,{get(target,key){
  const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
  if(key==='watchNotifications')return async function*(...args){try{yield* value.apply(target,args);}catch(error){throw safe(error);}};
  return async(...args)=>{try{return await value.apply(target,args);}catch(error){throw safe(error);}};
 }});
}
function safe(error){return messages[error?.code]?remoteError(error.code):Object.assign(remoteError('remote_request'),{code:/^[A-Z_]{1,64}$/.test(error?.code??'')?error.code:'remote_request'});}
