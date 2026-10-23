// Local admission adapter for the pinned WAHA Chatwoot App.
// Upstream source remains unchanged. Hook mismatches fail startup, not open access.
const Module=require('node:module');
const {AsyncLocalStorage}=require('node:async_hooks');
const {createHash}=require('node:crypto');
const {isMainThread}=require('node:worker_threads');
const context=new AsyncLocalStorage();
const state={handler:false,api:false,inbound:false,status:false};
const statusQueues=new Map();
function installStatus(Service){
 if(Service.prototype.__akeStatusGuard)return;const sync=Service.prototype.sync;
 if(typeof sync!=='function')throw Error('Unsupported WAHA status service');
 Service.prototype.sync=function(message){
  const key=[this.ackRepository.appPk,message.conversation_id,message.message_id].join(':');
  const work=(statusQueues.get(key)||Promise.resolve()).catch(()=>undefined).then(()=>sync.call(this,message));statusQueues.set(key,work);
  return work.finally(()=>{if(statusQueues.get(key)===work)statusQueues.delete(key);});
 };Service.prototype.__akeStatusGuard=true;state.status=true;
}
function nativeMessageHash(b){return createHash('sha256').update(JSON.stringify({content:b.content??null,attachments:(b.attachments||[]).map(a=>({id:Number(a.id),file_type:a.file_type,data_url:a.data_url})).sort((a,b)=>a.id-b.id)})).digest('hex');}
function messagePart(name,payload,body){
 const files=body.attachments||[],text=!!body.content&&files.length!==1;
 if(files.length>10)throw Error('At most ten attachments are enabled on this connection');
 if(name==='sendText'){if(!text)throw Error('Unexpected text part');return 1;}
 const indices=files.map((file,i)=>file.data_url===payload.file?.url?i:-1).filter(i=>i>=0);
 if(indices.length!==1)throw Error('Media must identify exactly one persisted attachment');
 return indices[0]+1+(text?1:0);
}
function mediaPayload(payload,body){
 if(!payload.file?.url)return payload;
 if(!(body.attachments||[]).some(a=>a.data_url===payload.file.url))throw Error('Media URL is not part of the persisted message');
 const publicURL=process.env.AKE_CHATWOOT_PUBLIC_URL,internalURL=process.env.AKE_CHATWOOT_INTERNAL_URL;
 if(!publicURL||!internalURL)return payload;
 const source=new URL(payload.file.url);
 if(source.origin!==new URL(publicURL).origin||!source.pathname.startsWith('/rails/active_storage/'))throw Error('Media URL is outside the approved Chatwoot storage');
 return {...payload,file:{...payload.file,url:new URL(source.pathname+source.search,internalURL).href}};
}
async function core(operation,body){
 const url=process.env.AKE_CORE_URL,key=process.env.AKE_INBOX_INTERNAL_KEY;
 if(!url||!key)throw Error('AKE WAHA admission is not configured');
 const r=await fetch(url+'/api/v1/inbox-v2/marketing/waha/'+operation,{method:'POST',headers:{'content-type':'application/json','x-inbox-key':key},signal:AbortSignal.timeout(10000),body:JSON.stringify(body)});
 if(!r.ok)throw Error('AKE WAHA admission unavailable');return r.json();
}
function installHandler(Handler){
 if(Handler.prototype.__akeGuard)return;const handle=Handler.prototype.handle;
 if(typeof handle!=='function')throw Error('Unsupported WAHA message handler');
 Handler.prototype.handle=function(body){const stable={...body,attachments:[...(body.attachments||[])].sort((a,b)=>Number(a.id)-Number(b.id))};return context.run({body:stable},()=>handle.call(this,stable));};Handler.prototype.__akeGuard=true;state.handler=true;
}
function installInbound(Base){
 if(Base.prototype.__akeInboundGuard)return;const process=Base.prototype.processJob;if(typeof process!=='function')throw Error('Unsupported WAHA receiving handler');
 Base.prototype.processJob=function(job){
  const event=job.data?.event;if(event?.event==='session.status')return process.call(this,job);
  const allowed=JSON.parse(global.process.env.AKE_WAHA_TEST_PEERS||'[]');let peer;try{peer=this.GetChatId(event);}catch{return;}
  if(!allowed.includes(peer))return;return process.call(this,job);
 };Base.prototype.__akeInboundGuard=true;state.inbound=true;
}
function installAPI(API,call=core){
 if(API.prototype.__akeGuard)return;
 for(const name of ['sendText','sendImage','sendFile','sendVoice','sendVideo']){
  const original=API.prototype[name];if(typeof original!=='function')throw Error('Unsupported WAHA sending API');
  API.prototype[name]=async function(payload,...args){
   const c=context.getStore();if(!c||process.env.AKE_WAHA_CONTROLLED!=='true')throw Error('WAHA send requires a persisted Inbox message');
   const b=c.body,part=messagePart(name,payload,b),request={accountId:Number(b.account?.id),inboxId:Number(b.inbox?.id??b.conversation?.inbox_id),conversationId:Number(b.conversation?.id),messageId:Number(b.id),part,session:payload.session,chatId:payload.chatId,nativeMessageHash:nativeMessageHash(b),payloadHash:createHash('sha256').update(JSON.stringify({method:name,payload})).digest('hex')};
   const outgoing=mediaPayload(payload,b);
   // A persisted WORKING state is insufficient: query the actual session again
   // before taking the send claim. Network/QR/failed states consume no claim.
   if(typeof this.get!=='function')throw Error('WAHA session health API unavailable');
   let health;try{health=await this.get(payload.session,{signal:AbortSignal.timeout(5000)});}catch{throw Error('WAHA session health unavailable; message remains unsent');}
   if(health?.status!=='WORKING')throw Error('WAHA session is not ready; reconnect before retry');
   const admission=await call('claim',request);if(!admission.allowed)throw Error('WAHA send paused or already attempted; review the receipt');
   try{const result=await original.call(this,outgoing,...args);if(!result?.id)throw Error('WAHA receipt identifier missing');await call('receipt',{key:admission.key,state:'accepted',responseId:String(result.id)});return result;}
   catch(error){await call('receipt',{key:admission.key,state:'review'}).catch(()=>undefined);throw Error('WAHA outcome requires review before retry');}
  };
 }
 API.prototype.__akeGuard=true;state.api=true;
 for(const name of ['deleteMessage','editMessage','forwardMessage'])if(typeof API.prototype[name]==='function')API.prototype[name]=async function(){throw Error('This message mutation is not enabled on the controlled Inbox connection');};
}
const originalLoad=Module._load;
// NODE_OPTIONS also reaches Pino logger workers and entrypoint probes. Those do
// not load Chatwoot consumers and must not run the application's hook watchdog.
const application=isMainThread&&/[\\/]dist[\\/]main(?:\.js)?$/.test(process.argv[1]||'');
if(application){
 Module._load=function(name,parent,main){const result=originalLoad.apply(this,arguments);let resolved=name;try{resolved=Module._resolveFilename(name,parent);}catch{}if(/[\\/]consumers[\\/]inbox[\\/]message_created\.js$/.test(resolved)&&result.MessageHandler)installHandler(result.MessageHandler);if(/(?:^|[\\/])WAHASelf\.js$/.test(resolved)&&result.WAHASelf)installAPI(result.WAHASelf);if(/[\\/]consumers[\\/]waha[\\/]base\.js$/.test(resolved)&&result.ChatWootWAHABaseConsumer)installInbound(result.ChatWootWAHABaseConsumer);if(/[\\/]services[\\/]MessageStatusService\.js$/.test(resolved)&&result.MessageStatusService)installStatus(result.MessageStatusService);return result;};
 if(process.env.AKE_WAHA_CONTROLLED==='true')setTimeout(()=>{if(!state.handler||!state.api||!state.inbound||!state.status){process.stderr.write('AKE WAHA guard hook verification failed '+JSON.stringify(state)+'\n');process.exit(78);}else process.stderr.write('AKE WAHA admission, status and test-peer hooks verified\n');},45000).unref();
}
module.exports={installHandler,installAPI,installInbound,installStatus,mediaPayload,nativeMessageHash,messagePart,state};
