// Run inside Core after migration; input is a private historical index bundle.
// Historical records are indexed in human mode. No send or CRM jobs are emitted.
import {createRequire} from 'node:module';
const require=createRequire('/app/package.json');
const fs=require('node:fs');
const {Pool}=require('pg');
const {FieldCipher}=require('/app/apps/revenue-core/dist/common/crypto');
const crypto=require('node:crypto');
const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const db=new Pool({connectionString:process.env.DATABASE_URL});
const cipher=new FieldCipher(process.env.FIELD_ENCRYPTION_KEY);
const pack=v=>cipher.encrypt(JSON.stringify(v));
const hash=v=>crypto.createHmac('sha256',process.env.FIELD_ENCRYPTION_KEY).update(v).digest('hex');
(async()=>{
 let count=0;
 for(const item of input.conversations){
  const c=item.conversation,t=c.meta.sender,group='contact:'+t.id,channel=item.channel;
  const verified=channel!=='website';
  const email=verified&&t.email?hash('email:'+t.email.trim().toLowerCase()):null;
  const phone=verified&&/^\+[1-9]\d{6,14}$/.test(t.phone_number||'')?hash('phone:'+t.phone_number):null;
  const old=(await db.query('SELECT group_key FROM inbox_v2_contacts WHERE account_id=$1 AND (email_hash=$2 OR phone_hash=$3) LIMIT 2',[input.accountId,email,phone])).rows;
  const identity=old.length===1?old[0].group_key:group;
  await db.query(`INSERT INTO inbox_v2_contacts(account_id,contact_id,group_key,email_hash,phone_hash,blocked,profile) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[input.accountId,t.id,identity,email,phone,!!t.blocked,pack(t)]);
  const profile={fields:{company:null,country:null,city:null,projectLocation:null,projectType:null,parkingSpaces:null,products:[],estimatedAmount:null,currency:null,timeline:null},confirmed:[],evidence:[],asked:[]};
  await db.query("INSERT INTO inbox_v2_conversations(account_id,conversation_id,contact_id,inbox_id,channel,mode,native_status,profile) VALUES($1,$2,$3,$4,$5,'human',$6,$7) ON CONFLICT DO NOTHING",[input.accountId,c.id,t.id,c.inbox_id,channel,c.status,pack(profile)]);count++;
 }
 for(const event of input.legacyEvents){
  await db.query('INSERT INTO inbox_v2_events(account_id,event_key,conversation_id,kind,payload,occurred_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[input.accountId,'message_created:'+event.id,event.cid,'legacy_message',pack(event),new Date(event.created*1000)]);
  if(['pending','processing','review'].includes(event.status))await db.query("INSERT INTO inbox_v2_jobs(id,account_id,conversation_id,kind,state,payload,error) VALUES($1,$2,$3,'legacy','review',$4,'legacy_delivery_requires_review') ON CONFLICT DO NOTHING",['legacy:message:'+event.id,input.accountId,event.cid,pack(event)]);
 }
 for(const entry of input.knowledge){
  await db.query("INSERT INTO inbox_v2_knowledge(id,version,title,body,source_id,source_hash,tags,state,reviewed_by,reviewed_at) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",[entry.id,entry.title,entry.body,entry.sourceId,entry.sourceHash,entry.tags,entry.state,entry.state==='approved'?'release-source-review':null,entry.state==='approved'?new Date():null]);
 }
 await db.query("INSERT INTO inbox_v2_audit(account_id,actor,action,target,detail) VALUES($1,'release','historical_index','v0.2',$2)",[input.accountId,{conversations:count,legacyEvents:input.legacyEvents.length,knowledge:input.knowledge.length,noAutomaticReplay:true}]);
 console.log(JSON.stringify({indexed:count,legacyEvents:input.legacyEvents.length,knowledge:input.knowledge.length,noAutomaticReplay:true}));
})().finally(()=>db.end());
