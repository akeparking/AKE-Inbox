// Execute inside the pinned WAHA container. Uses an isolated in-memory database,
// upstream repository/service classes and a captured native status sink.
const assert=require('node:assert/strict');
const knex=require('/app/node_modules/knex')({client:'better-sqlite3',connection:{filename:':memory:'},useNullAsDefault:true});
const {WhatsAppAckRepository}=require('/app/dist/apps/chatwoot/storage/WhatsAppAckRepository');
const {MessageStatusService}=require('/app/dist/apps/chatwoot/services/MessageStatusService');
const {installStatus}=require('/opt/ake/waha-guard.cjs');
installStatus(MessageStatusService);
(async()=>{
 const result=[];
 await knex.schema.createTable('app_chatwoot_whatsapp_acks',t=>{t.integer('app_pk');t.string('message_id');t.integer('ack');t.datetime('timestamp');t.unique(['app_pk','message_id']);});
 const repo=new WhatsAppAckRepository(knex,77),other=new WhatsAppAckRepository(knex,78),writes=[];
 let mapped=[{message_id:'part-a'}];const service=new MessageStatusService({getWhatsAppMessage:async()=>mapped},repo,{ConversationById:()=>({updateMessageStatus:async(_,s)=>{writes.push(s);}})}),message={conversation_id:17,message_id:19,parts:2};
 await repo.record('part-a',3,new Date());assert.equal(await service.sync(message),null);mapped.push({message_id:'part-b'});assert.equal(await service.sync(message),null);await repo.record('part-b',2,new Date());assert.equal(await service.sync(message),'delivered');result.push({id:'W01',scenario:'Missing mapping or acknowledgement prevents multipart completion',status:'passed'});
 await repo.record('part-b',3,new Date());assert.equal(await service.sync(message),'read');await repo.record('part-b',2,new Date(0));await repo.record('part-a',1,new Date());assert.equal(await service.sync(message),'read');assert.equal(await other.minimumAck(['part-a','part-b']),null);result.push({id:'W02',scenario:'Out-of-order acknowledgements cannot regress READ; app scopes remain separate',status:'passed'});
 let concurrent=0,maximum=0;const slow=new MessageStatusService({getWhatsAppMessage:async()=>{concurrent++;maximum=Math.max(maximum,concurrent);await new Promise(r=>setTimeout(r,10));concurrent--;return mapped;}},repo,{ConversationById:()=>({updateMessageStatus:async()=>{}})});
 await Promise.all(Array.from({length:12},()=>slow.sync(message)));assert.equal(maximum,1);result.push({id:'W03',scenario:'Concurrent status aggregation for one native message is serialized',status:'passed'});
 await repo.record('part-a',4,new Date());assert.equal(await service.sync(message),'read');result.push({id:'W04',scenario:'PLAYED remains READ without inventing a new native state',status:'passed'});
 console.log(JSON.stringify({boundary:'Pinned upstream classes + isolated SQLite + captured native writes; no external messages',results:result},null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>knex.destroy());
