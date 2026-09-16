import {connectionBootstrap} from './bootstrap.mjs';
import {monitorInstructions} from './foreground-wait.mjs';

const reject = code => { throw Object.assign(new Error(code), { code }); };
// Admission redeems the invite exactly once. The application associates its
// issued invitation with the admitted native seat; the CID is diagnostic.
export async function connectInvite(session, invite, profile, registry=session.connections) {
  if (session.bound) reject('session_already_bound');
  if (session.inviteAttempted) reject('invite_already_attempted');
  if(!registry)reject('connection_registry_unavailable');
  session.inviteAttempted = true;
  let row=await registry.reserve(profile,invite);
  const client = await session.ensureAttached();
  try {
    await client.createIdentity({name:row.identity_name,bio:`Persistent Cowork ${profile} agent`,exposeLocal:false,localAutoAccept:false});
    const identity=await client.currentIdentity();
    if(identity.name!==row.identity_name||!(/^[A-Fa-f0-9]{64}$/.test(identity.cid)))reject('identity_in_use');
    row=await registry.update(row,{state:'identity_created',identity_cid:identity.cid.toUpperCase()});
    row=await registry.update(row,{state:'invite_attempted'});
    const contact=await client.addContact({invite});
    const contacts=await client.listContacts(),ready=contacts.contacts?.some(c=>c.container_id.toUpperCase()===contact.cid.toUpperCase());
    row=await registry.update(row,{state:'connected',room_name:contact.display,contact_cid:contact.cid.toUpperCase(),membership_state:ready?'ready':'connecting'});
    session.bound=row;return connectionResult(row,profile);
  }catch(error){await session.release();throw Object.assign(error,{connection_id:row.connection_id,identity_name:row.identity_name,identity_retained:true});}
}
export function connectionResult(row,profile){return {connection_id:row.connection_id,room_name:row.room_name,as_agent:row.identity_name,agent_cid:row.identity_cid,room_cid:row.contact_cid,profile,identity_lifetime:'persistent',status:row.membership_state==='ready'?'connected':'connecting',authorization:'application_association_pending',bootstrap:connectionBootstrap(),monitoring_instructions:monitorInstructions};}
export async function reconnectInvite(session,connectionId,profile,registry=session.connections){
 if(session.bound)reject('session_already_bound');
 const row=await registry.get(connectionId,profile);if(row.state!=='connected')reject('connection_outcome_unresolved');
 const client=await session.ensureAttached();
 try{
  await client.chooseIdentity({name:row.identity_name,force:false});
  const identity=await client.currentIdentity();if(identity.name!==row.identity_name||identity.cid?.toUpperCase()!==row.identity_cid)reject('identity_mismatch');
  const contacts=await client.listContacts();if(![...contacts.contacts??[],...contacts.pending??[]].some(c=>(c.container_id??c.cid)?.toUpperCase()===row.contact_cid))reject('room_contact_missing');
  const ready=contacts.contacts?.some(c=>c.container_id?.toUpperCase()===row.contact_cid);
  session.bound={...row,membership_state:ready?'ready':'connecting'};return connectionResult(session.bound,profile);
 }catch(error){await session.release();if(error.code==='BOUND_ELSEWHERE')reject('identity_in_use');throw error;}
}

export async function markReady(registry, row) {
  if (row.ephemeral||row.connection_id) { row.membership_state = 'ready'; return row; }
  return registry.updateState(row.room_name, 'ready');
}
