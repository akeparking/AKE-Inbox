import {createHash} from 'node:crypto';
export async function bridgeControl(config,body,operation,state){
  if(!config.marketing_bridge_control)return {allowed:true,managed:false};
  if(!config.inbox_core_url||!config.inbox_internal_key)throw Error('bridge_authority_unavailable');
  const input={inboxId:Number(body.inbox?.id??body.conversation?.inbox_id),conversationId:Number(body.conversation?.id),messageId:Number(body.id),state};
  if(operation==='claim')input.nativeMessageHash=createHash('sha256').update(JSON.stringify({content:body.content??null,attachments:(body.attachments||[]).map(a=>({id:Number(a.id),file_type:a.file_type,data_url:a.data_url})).sort((a,b)=>a.id-b.id)})).digest('hex');
  const r=await fetch(config.inbox_core_url+'/api/v1/inbox-v2/marketing/bridge/'+operation,{method:'POST',headers:{'content-type':'application/json','x-inbox-key':config.inbox_internal_key},body:JSON.stringify(input),signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw Error('bridge_authority_unavailable');return {...await r.json(),managed:true};
}
