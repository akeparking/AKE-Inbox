import {describe,it,expect,vi,beforeAll,beforeEach,afterAll} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InboxRepository} from '../inbox-v2/repository';
import {InboxAutomation} from '../inbox-v2/automation.service';
import {MarketingService} from './service';
import {BridgeControl} from './bridge';
import {InboxV2Controller} from '../inbox-v2/controller';

describe.skipIf(!process.env.MARKETING_TEST_DATABASE_URL)('Remaining marketing gaps, isolated PostgreSQL',()=>{
 vi.setConfig({testTimeout:30000,hookTimeout:30000});
 let repo:InboxRepository,marketing:MarketingService,automation:InboxAutomation,archive:string;
 const admin:any={accountId:1,userId:7,role:'administrator',credentials:{}},agent:any={...admin,userId:8,role:'agent'};
 const native=new Map<number,any>(),cw:any={account:vi.fn(async(p:string)=>native.get(Number(p.split('/').at(-1)))),allowed:vi.fn(async(a:any,id:number)=>{if(!native.has(id)||a.role!=='administrator'&&id!==101)throw Error('forbidden');return native.get(id);}),messages:vi.fn(async()=>[])};
 const grant={analytics:'granted',adStorage:'denied',adUserData:'denied',adPersonalization:'denied'},origin='https://fictional.invalid',siteId='gap-fixture',formId=randomUUID();
 const body=(id:number,cid:number,inbox=1)=>({event:'message_created',id,message_type:'incoming',private:false,content:'Fictional acceptance inquiry',account:{id:1},conversation:{id:cid,inbox_id:inbox},created_at:Date.now()/1000});
 const fixture=(cid:number,inbox=1,extra:any={})=>native.set(cid,{id:cid,account_id:1,inbox_id:inbox,status:'open',meta:{sender:{id:cid,name:'Same fictional name',...extra}}});
 beforeAll(async()=>{archive=await mkdtemp(join(tmpdir(),'ake-gap-'));Object.assign(process.env,{DATABASE_URL:process.env.MARKETING_TEST_DATABASE_URL,INBOX_V2_ENABLED:'true',MARKETING_ENABLED:'true',ATTRIBUTION_UI_ENABLED:'true',ATTRIBUTION_CAPTURE_ENABLED:'true',QUALIFIED_FEEDBACK_ENABLED:'true',FIELD_ENCRYPTION_KEY:'31'.repeat(32),INBOX_INTERNAL_KEY:'fixture-key',CHATWOOT_API_TOKEN:'fixture-token',INBOX_EFFECTIVE_FROM:'2026-01-01T00:00:00Z',INBOX_CHANNELS:'{"1":"email","2":"whatsapp","3":"website"}',INBOX_AUTO_SEND:'false',OKKI_WRITE_ENABLED:'false',INBOX_ARCHIVE_ROOT:archive});repo=new InboxRepository();automation=new InboxAutomation(repo,cw,{} as any,{} as any);marketing=new MarketingService(repo,cw,{} as any,automation);});
 afterAll(async()=>{await repo?.onModuleDestroy();if(archive)await rm(archive,{recursive:true,force:true});});
 beforeEach(async()=>{native.clear();vi.clearAllMocks();await repo.db.query('TRUNCATE marketing_sites,marketing_bridge_owners,marketing_bridge_dispatches,marketing_waha_sends,inbox_v2_contacts,inbox_v2_conversations,inbox_v2_jobs,inbox_v2_events,inbox_v2_links,inbox_v2_audit CASCADE');await repo.db.query('INSERT INTO marketing_sites(id,account_id,name,origin,inbox_id,settings,enabled) VALUES($1,1,$1,$2,3,$3,true)',[siteId,origin,{iframeOrigins:['https://form.fictional.invalid']}]);await repo.db.query('INSERT INTO marketing_forms(id,site_id,name,draft,published_version) VALUES($1,$2,$3,$4,1)',[formId,siteId,'Fixture',{fields:[]}]);const def={heading:'Fixture',submitLabel:'Send',successMessage:'Received',language:'en',placement:'inline',fields:[{key:'message',type:'textarea',label:'Message',required:true,mapping:'message',options:[]}]};await repo.db.query('INSERT INTO marketing_form_versions(form_id,version,definition,published_by) VALUES($1,1,$2,$3)',[formId,def,'7']);});
 const session=()=>marketing.session({siteId,pageUrl:origin+'/product',consent:grant,policyVersion:'fixture'},origin);
 it('G01 traverses more than 200 visitors and 1000 events without loss or duplicate rows',async()=>{
   const s=await session();await repo.db.query('INSERT INTO marketing_visitors(id,site_id,first_touch,consent_id) SELECT gen_random_uuid(),$1,$2,$3 FROM generate_series(1,220)',[siteId,{},(await repo.db.query('SELECT consent_id FROM marketing_visitors WHERE id=$1',[s.visitorId])).rows[0].consent_id]);
   let cursor,seen:string[]=[];do{const d:any=await marketing.action(admin,'visitors',{limit:37,cursor});seen.push(...d.visitors.map((v:any)=>v.id));cursor=d.nextCursor;}while(cursor);expect(seen.length).toBe(221);expect(new Set(seen).size).toBe(221);
   await repo.db.query("INSERT INTO marketing_events(event_id,site_id,visitor_id,visit_id,event_type,request_hash,data) SELECT gen_random_uuid(),$1,$2,$3,'page_view','fixture','{}'::jsonb FROM generate_series(1,1021)",[siteId,s.visitorId,s.visitId]);let sequences:string[]=[];cursor=undefined;do{const d:any=await marketing.action(admin,'visitor',{id:s.visitorId,limit:199,cursor});sequences.push(...d.events.map((e:any)=>e.sequence));cursor=d.nextCursor;}while(cursor);expect(sequences.length).toBe(1021);expect(new Set(sequences).size).toBe(1021);
 });
 it('G02 an agent reaches older authorized inquiries behind 210 unauthorized records',async()=>{
   fixture(101);fixture(102);const fields=repo.pack({fields:{message:'Fictional'},definition:{fields:[{key:'message',mapping:'message'}]}});
   await repo.db.query("INSERT INTO marketing_inquiries(id,site_id,account_id,source_submission_id,source_kind,request_hash,payload,conversation_id,created_at) SELECT gen_random_uuid(),$1,1,n::text,'email','fixture',$2,CASE WHEN n<3 THEN 101 ELSE 102 END,'2026-01-01'::timestamptz+(n||' seconds')::interval FROM generate_series(0,212) n",[siteId,fields]);
   const one:any=await marketing.action(agent,'inquiries',{limit:2});expect(one.inquiries).toHaveLength(2);expect(one.inquiries.every((i:any)=>i.conversation_id==='101')).toBe(true);
   const two:any=await marketing.action(agent,'inquiries',{limit:2,cursor:one.nextCursor});expect(two.inquiries).toHaveLength(1);expect(two.inquiries[0].id).not.toBe(one.inquiries[0].id);expect(two.nextCursor).toBeNull();
   await expect(marketing.action(admin,'visitors',{cursor:one.nextCursor})).rejects.toThrow();await expect(marketing.action({...agent,userId:9},'inquiries',{cursor:one.nextCursor})).rejects.toThrow();
 });
 it('G03 cross-channel optional addresses never auto-merge; reviewed linking is versioned and replay-safe',async()=>{
   fixture(101,1,{email:'same@example.invalid',phone_number:'+15555550111'});fixture(102,2,{email:'same@example.invalid',phone_number:'+15555550111'});await automation.ingest(body(1,101));await automation.ingest(body(2,102,2));const a=(await repo.conversation(101))!,b=(await repo.conversation(102))!;expect(a.group_key).not.toBe(b.group_key);
   const request={conversationId:101,otherConversationId:102,expectedRevision:a.revision,otherExpectedRevision:b.revision,confirmed:true,reason:'Both channels verified using fictional challenge',evidenceRefs:['fixture:challenge-verified'],requestId:randomUUID()};
   await expect(automation.linkIdentity(agent,request)).rejects.toThrow();await expect(automation.linkIdentity(admin,{...request,expectedRevision:999})).rejects.toThrow();
   await repo.db.query('INSERT INTO inbox_v2_links(account_id,group_key,company_id) VALUES(1,$1,$2)',[b.group_key,'fictional-company']);await repo.db.query('UPDATE inbox_v2_contacts SET opted_out=true WHERE contact_id=102');
   expect(await automation.linkIdentity(admin,request)).toEqual({ok:true});expect(await automation.linkIdentity(admin,request)).toMatchObject({duplicate:true});expect((await repo.conversation(101))!.group_key).toBe((await repo.conversation(102))!.group_key);expect((await repo.conversation(101))!.opted_out).toBe(true);expect((await repo.db.query('SELECT company_id FROM inbox_v2_links')).rows[0].company_id).toBe('fictional-company');expect((await repo.db.query("SELECT count(*)::int n FROM inbox_v2_audit WHERE action='identity.linked'")).rows[0].n).toBe(1);
 });
 it('G04 two CRM-linked identities and conflicting verified identifiers remain separate',async()=>{
   fixture(101,1,{email:'one@example.invalid'});fixture(102,2,{phone_number:'+15555550112'});await automation.ingest(body(1,101));await automation.ingest(body(2,102,2));const a=(await repo.conversation(101))!,b=(await repo.conversation(102))!;for(const [g,c]of [[a.group_key,'company-one'],[b.group_key,'company-two']])await repo.db.query('INSERT INTO inbox_v2_links(account_id,group_key,company_id) VALUES(1,$1,$2)',[g,c]);
   await expect(automation.linkIdentity(admin,{conversationId:101,otherConversationId:102,expectedRevision:a.revision,otherExpectedRevision:b.revision,confirmed:true,reason:'Fictional company conflict check',evidenceRefs:['fixture:two-companies'],requestId:randomUUID()})).rejects.toThrow('CRM records');
   fixture(103,3,{email:'one@example.invalid',phone_number:'+15555550112'});await automation.ingest(body(3,103,3));await repo.db.query('UPDATE inbox_v2_contacts SET identity_verified=true WHERE contact_id=103');await automation.ingest(body(4,103,3));expect((await repo.db.query('SELECT identity_conflict FROM inbox_v2_contacts WHERE contact_id=103')).rows[0].identity_conflict).toBe(true);expect((await repo.conversation(103))!.group_key).not.toBe(a.group_key);expect((await repo.db.query('SELECT count(*)::int n FROM inbox_v2_links')).rows[0].n).toBe(2);
 });
 it('G05 cutover and rollback require pause, block uncertain sends and exclude old-message replay',async()=>{
   const bridge=new BridgeControl(repo),change=(provider:string,rev:number,last=0)=>bridge.transition(admin,{inboxId:2,provider,expectedRevision:rev,lastKnownMessageId:last,reason:'Isolated bridge rollback acceptance'});
   await expect(change('waha',0)).rejects.toThrow('paused');await change('paused',0);await change('waha',1,100);
   const claim=(provider:'waha'|'evolution',id:number)=>repo.transaction('bridge:1:2',db=>bridge.claim(db,{inboxId:2,messageId:id,provider,parts:1}));
   expect((await claim('evolution',101)).allowed).toBe(false);expect((await claim('waha',100)).allowed).toBe(false);expect((await claim('waha',101)).allowed).toBe(true);
   await change('paused',2,101);await expect(change('evolution',3,101)).rejects.toThrow('Reconcile');await repo.db.query("UPDATE marketing_bridge_dispatches SET state='accepted'");await change('evolution',3,101);expect((await claim('waha',102)).allowed).toBe(false);expect((await claim('evolution',101)).allowed).toBe(false);expect((await claim('evolution',102)).allowed).toBe(true);expect((await claim('evolution',102)).allowed).toBe(false);
   await repo.db.query("UPDATE marketing_bridge_dispatches SET state='accepted'");await change('paused',4,102);await change('waha',5,102);expect((await claim('waha',102)).allowed).toBe(false);expect((await claim('waha',103)).allowed).toBe(true);
 });
 it('G06 approved iframe context associates only a trusted receipt; spoofed origin, token misuse and revocation are safe',async()=>{
   const s=await session(),input={siteId,sessionToken:s.sessionToken,formId,childOrigin:'https://form.fictional.invalid'};
   await expect(marketing.iframeContext({...input,childOrigin:'https://evil.invalid'},origin)).rejects.toThrow();const frame=await marketing.iframeContext(input,origin);await expect(marketing.claims(frame.token,siteId)).rejects.toThrow();
   const receipt={siteId,persistedReceiptId:'iframe-local-1',iframeToken:frame.token,iframeOrigin:input.childOrigin,formId,version:1,fields:{message:'Fictional persisted frame inquiry'}};const r=await marketing.trustedReceipt(receipt,origin);expect((await repo.db.query('SELECT visitor_id FROM marketing_inquiries WHERE id=$1',[r.inquiryId])).rows[0].visitor_id).toBe(s.visitorId);expect((await marketing.trustedReceipt(receipt,origin)).duplicate).toBe(true);
   await marketing.session({siteId,pageUrl:origin,consent:{...grant,analytics:'denied'},policyVersion:'revoke',visitorToken:s.visitorToken},origin);const revoked=await marketing.trustedReceipt({...receipt,persistedReceiptId:'iframe-local-2'},origin);expect((await repo.db.query('SELECT visitor_id FROM marketing_inquiries WHERE id=$1',[revoked.inquiryId])).rows[0].visitor_id).toBeNull();
 });
 it('G07 attachment limit blocks before transport without loading oversized bytes',async()=>{
   const directory=join(archive,'messages','990');await mkdir(directory,{recursive:true});const data=Buffer.alloc(21*1024*1024,7),sha=createHash('sha256').update(data).digest('hex'),blobDir=join(archive,'blobs',sha.slice(0,2));await mkdir(blobDir,{recursive:true});await writeFile(join(blobDir,sha),data);const snapshot={record:{id:990,content:'Fixture'},attachments:[{file:{path:'blobs/'+sha.slice(0,2)+'/'+sha,byte_size:data.length,sha256:sha}}]},bytes=JSON.stringify(snapshot),digest=createHash('sha256').update(bytes).digest('hex');await writeFile(join(directory,digest+'.json'),bytes);const message={id:990,content:'Fixture',attachments:[{}]};expect(await (marketing as any).archivedMessage(message)).toBe(false);process.env.WAHA_MAX_ATTACHMENT_BYTES=String(25*1024*1024);try{expect(await (marketing as any).archivedMessage(message)).toBe(true);}finally{delete process.env.WAHA_MAX_ATTACHMENT_BYTES;}

 });
 it('G08 automatic CRM matching uses only channel-proven addresses and holds conflicted identities',async()=>{
   fixture(102,2,{phone_number:'+15555550113',email:'unverified@example.invalid'});await automation.ingest(body(1,102,2));const c=(await repo.conversation(102))!,sync=vi.fn(async()=>({lead_id:'fictional-lead',company_id:null}));(automation.okki as any).syncLead=sync;process.env.OKKI_WRITE_ENABLED='true';process.env.INBOX_AUTO_CHANNELS='whatsapp';
   try{
     await repo.job('okki','crm-fixture-1',102,c.group_key,c.revision,{});await automation.sync((await repo.db.query("SELECT * FROM inbox_v2_jobs WHERE id='crm-fixture-1'")).rows[0]);expect(sync).toHaveBeenCalledTimes(1);expect((sync.mock.calls[0] as any)[2]).toMatchObject({email:'',phone_number:'+15555550113'});
     await repo.db.query('UPDATE inbox_v2_contacts SET identity_conflict=true WHERE contact_id=102');await repo.job('okki','crm-fixture-2',102,c.group_key,c.revision,{});await automation.sync((await repo.db.query("SELECT * FROM inbox_v2_jobs WHERE id='crm-fixture-2'")).rows[0]);expect(sync).toHaveBeenCalledTimes(1);expect((await repo.db.query("SELECT state,error FROM inbox_v2_jobs WHERE id='crm-fixture-2'")).rows[0]).toEqual({state:'review',error:'identity_conflict'});
   }finally{process.env.OKKI_WRITE_ENABLED='false';process.env.INBOX_AUTO_CHANNELS='';}
 });
 it('G09 Evolution admission cannot bypass ownership on an enrolled inbox',async()=>{
   fixture(102,2,{phone_number:'+15555550114'});await automation.ingest(body(1,102,2));const bridge=new BridgeControl(repo),controller=new InboxV2Controller(repo,cw,automation,{} as any,marketing),req={headers:{'x-inbox-key':'fixture-key'}} as any;
   const change=(provider:string,revision:number)=>bridge.transition(admin,{inboxId:2,provider,expectedRevision:revision,lastKnownMessageId:0,reason:'Isolated legacy bridge admission proof'});await change('paused',0);await change('waha',1);
   expect(await controller.admission({accountId:1,conversationId:102,provider:'evolution'},req)).toMatchObject({allowed:false,managedBridge:true});await change('paused',2);await change('evolution',3);
   expect(await controller.admission({accountId:1,conversationId:102,provider:'evolution'},req)).toMatchObject({allowed:true,managedBridge:true});
 });
 it('G10 legacy optional address hashes cannot become proof for a new channel',async()=>{
   fixture(102,2,{phone_number:'+15555550115',email:'legacy-optional@example.invalid'});await automation.ingest(body(1,102,2));await repo.db.query('UPDATE inbox_v2_contacts SET email_hash=$1 WHERE contact_id=102',[repo.identity('email:legacy-optional@example.invalid')]);
   fixture(101,1,{email:'legacy-optional@example.invalid'});await automation.ingest(body(2,101));expect((await repo.conversation(101))!.group_key).not.toBe((await repo.conversation(102))!.group_key);
 });
});
