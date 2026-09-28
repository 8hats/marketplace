import {spawn} from 'node:child_process';

// A cold Windows PowerShell can spend more than ten seconds initializing modules.
// Bound every inspection, including process startup, and never accept an incomplete result.
export const INSPECTION_TIMEOUT_MS=30000;
export function inspectWindowsState(executable,script,target,directory,spawnProcess=spawn){
 return new Promise((resolve,reject)=>{
  let child,timer,settled=false,output='';
  const finish=(code)=>{
   if(settled)return;
   settled=true;clearTimeout(timer);
   if(code)reject(Object.assign(Error(code),{code}));else resolve();
  };
  const failed=()=>finish('state_inspection_failed');
  const abort=()=>{if(settled)return;failed();child?.kill();};
  try {
   child=spawnProcess(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:['pipe','pipe','ignore'],windowsHide:true});
   timer=setTimeout(abort,INSPECTION_TIMEOUT_MS);
   child.stdout.on('data',chunk=>{if(settled)return;output+=chunk;if(output.length>128)abort();});
   child.stdout.once('error',abort);
   child.once('error',failed);
   child.stdin.once('error',abort);
   // exit can precede the final stdout data. close follows drained stdio.
   child.once('close',code=>{
    if(code===0&&output==='private')finish();
    else if(code===1&&output==='unsafe')finish(directory?'unsafe_state_directory':'unsafe_connection_state');
    else failed();
   });
   child.stdin.end(JSON.stringify({path:target,directory}));
  } catch {abort();}
 });
}
