// Only the room's structural-validation namespace may expose actionable server details.
// Never persist these details as diagnostics, and never classify a transport failure as rejection.
const bounded=(value,max)=>typeof value==='string'&&value.length<=max?value:undefined;
export function conversationErrorDetails(error,status){
 if(!error||!/^conversation_structure_[a-z_]{1,40}$/.test(error.code??'')||status<400||status>=500)return {};
 const message=bounded(error.message,2000),fields=[];
 if(Array.isArray(error.fields))for(const field of error.fields.slice(0,30)){
  const path=bounded(field?.path,256),message=bounded(field?.message,512),code=bounded(field?.code,64);
  if(path!==undefined&&message!==undefined)fields.push({path,message,...(code?{code}:{})});
 }
 return {...(message?{validation_message:message}:{}),...(fields.length?{validation_fields:fields}:{}),...(error.effect==='none'?{domain_effect:'none'}:{})};
}

export function conversationToolError(error){
 return {...(typeof error.validation_message==='string'?{message:error.validation_message}:{}),
  ...(Array.isArray(error.validation_fields)?{fields:error.validation_fields}:{}),
  ...(error.domain_effect==='none'?{effect:'none'}:{})};
}
