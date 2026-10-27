import {describe,it,expect,vi,beforeAll,afterAll,beforeEach} from 'vitest';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InboxExports} from './exports';
import {createHash} from 'node:crypto';
import {config,opportunitySchema,emptyProfile} from './contracts';
import {workTime,followupDates,mergeFields,isAutomaticMail,csvCell,supportedEvidence,intakeQuestion} from './policy';
import {InboxRepository} from './repository';
import {InboxAutomation} from './automation.service';
import {OkkiWriter,UncertainWrite,identityMatch,opportunityCompanyId} from './okki';
import {Chatwoot} from './chatwoot';
import {InboxV2Controller} from './controller';
import {zip,xlsx} from './export-format';
import {UnauthorizedException,ServiceUnavailableException} from '@nestjs/common';
const project={idempotencyKey:'test-opportunity',confirmed:true,name:'Fictional acceptance project',projectLocation:'Dubai Test Site',products:['ANPR camera'],estimatedAmount:0,currency:'USD',companyId:'10',contactIds:['20'],businessTypeId:'0',flowId:'30',stageId:'40',ownerId:'50'};
describe('Inbox policy boundaries',()=>{
 it('allows basic intake questions without removing the uncovered product question gate',()=>{
   for(const text of ['你好，现在有人可以接待吗？','项目在迪拜，有200个车位。我们需要先整理哪些信息？','What project details should we provide?'])expect(intakeQuestion(text)).toBe(true);
   for(const text of ['设备兼容哪些摄像头？','准确报价是多少？','What project details should we provide? Does the camera support every protocol?','设备兼容哪些摄像头？我们需要先整理哪些信息？'])expect(intakeQuestion(text)).toBe(false);
 });
 it('reads OKKI company relation from both list and detail shapes',()=>{expect(opportunityCompanyId({company:{company_id:123}})).toBe('123');expect(opportunityCompanyId({company_id:123})).toBe('123');});
 it('requires actual project location, products, amount and currency; preserves explicit zero',()=>{expect(opportunitySchema.safeParse(project).success).toBe(true);for(const k of ['projectLocation','products','estimatedAmount','currency'])expect(opportunitySchema.safeParse({...project,[k]:undefined}).success).toBe(false);expect(opportunitySchema.safeParse({...project,estimatedAmount:null}).success).toBe(false);});
 it('checks current tenant customer requirements and accepts an explicit unknown intention',async()=>{
   const writer=new OkkiWriter({} as any);
   vi.spyOn(writer,'companyDefinition').mockResolvedValue({requiredFields:[{id:'country',name:'国家地区'},{id:'biz_type',name:'客户类型'},{id:'intention_level',name:'采购意向'}],bizTypes:[{id:'其他',name:'其他'}],intentionLevels:[{id:'0',name:'未知'}]});
   await expect(writer.validateCompanyPayload({name:'Fictional'})).rejects.toThrow('国家地区、客户类型、采购意向');
   await expect(writer.validateCompanyPayload({country:'CN',biz_type:'其他',intention_level:0})).resolves.toBeUndefined();
   await expect(writer.validateCompanyPayload({country:'CN',biz_type:'invented',intention_level:0})).rejects.toThrow('客户类型');
   await expect(writer.validateCompanyPayload({country:'CN',biz_type:'其他',intention_level:99})).rejects.toThrow('采购意向');
 });
 it('does not guess a newly required tenant custom field',async()=>{
   const writer=new OkkiWriter({} as any);
   vi.spyOn(writer,'companyDefinition').mockResolvedValue({requiredFields:[{id:'tenant_custom',name:'已核实的采购分类'}],bizTypes:[],intentionLevels:[]});
   await expect(writer.validateCompanyPayload({name:'Fictional'})).rejects.toThrow('已核实的采购分类');
 });
 it('protects human fields and preserves stated zero',()=>{const old={...emptyProfile().fields,company:'Reviewed'};expect(mergeFields(old,{company:'Model edit',parkingSpaces:0},['company'])).toMatchObject({company:'Reviewed',parkingSpaces:0});});
 it('schedules within the confirmed local window including DST',()=>{expect(workTime(new Date('2026-11-01T06:30:00Z'),'America/New_York').toISOString()).toBe('2026-11-01T14:00:00.000Z');expect(followupDates(new Date(),null)).toEqual([]);expect(followupDates(new Date('2026-10-07T02:00:00Z'),'Asia/Shanghai').map(d=>d.toISOString())).toEqual(['2026-10-08T02:00:00.000Z','2026-10-10T02:00:00.000Z']);});
 it('suppresses bounce and auto-reply mail loops',()=>{expect(isAutomaticMail({content_attributes:{email:{headers:{'auto-submitted':'auto-generated'}}}},'test')).toBe(true);expect(isAutomaticMail({subject:'Undeliverable: project'},'test')).toBe(true);});
 it('never matches identity using a same name',()=>{expect(identityMatch({customers:[{name:'Same Name',email:'one@example.invalid'}]},'two@example.invalid','')).toBe(false);expect(identityMatch({customers:[{contact:[{type:'whatsapp',value:'+971500000001'}]}]},'','+971500000001')).toBe(true);});
 it('rejects invented numeric evidence and accepts explicit zero',()=>{expect(supportedEvidence(500,'I need parking')).toBe(false);expect(supportedEvidence(0,'0 parking spaces')).toBe(true);expect(supportedEvidence('USD','Budget 400 EUR')).toBe(false);});
 it('escapes spreadsheet formulas and traversal paths',()=>{expect(csvCell('=CMD()')).toBe('"\'=CMD()"');expect(()=>zip({'../secret':Buffer.from('x')})).toThrow('unsafe_export_path');const data=xlsx([['=CMD()','项目',0]]);expect(data.includes(Buffer.from('<f>'))).toBe(false);expect(data.includes(Buffer.from('项目'))).toBe(true);});
});
const dbEnabled=!!process.env.INBOX_TEST_DATABASE_URL;
describe.skipIf(!dbEnabled)('Persistent Inbox controls (isolated PostgreSQL)',()=>{
 let store:InboxRepository,service:InboxAutomation,okki:OkkiWriter;
 const native=(cid:number)=>({id:cid,account_id:1,inbox_id:1,status:'open',meta:{sender:{id:cid===101?1:2,name:'Fictional test',email:'test@example.invalid',custom_attributes:{ake_identity_verified:true}}}});
 const cw:any={account:vi.fn(async(path:string)=>native(Number(path.split('/').at(-1)))),allowed:vi.fn(async(_:any,cid:number)=>native(cid)),send:vi.fn(async()=>900),messages:vi.fn(async()=>[])};
 const actor:any={userId:7,accountId:1,role:'administrator',credentials:{}};
 beforeAll(async()=>{Object.assign(process.env,{INBOX_V2_ENABLED:'true',DATABASE_URL:process.env.INBOX_TEST_DATABASE_URL,FIELD_ENCRYPTION_KEY:'11'.repeat(32),INBOX_INTERNAL_KEY:'isolated-test-key',CHATWOOT_API_TOKEN:'isolated-token',INBOX_EFFECTIVE_FROM:'2026-01-01T00:00:00Z',INBOX_CHANNELS:'{"1":"email"}',INBOX_AUTO_SEND:'true',INBOX_AUTO_CHANNELS:'email',OKKI_WRITE_ENABLED:'true'});store=new InboxRepository();await store.db.query(await readFile(__dirname+'/../database/migrations/003_inbox_v2.sql','utf8'));await store.db.query(await readFile(__dirname+'/../database/migrations/007_office_reception.sql','utf8'));okki=new OkkiWriter(store);service=new InboxAutomation(store,cw,okki,{cleanup:async()=>{}} as any);});
 afterAll(async()=>{await store?.onModuleDestroy();vi.unstubAllGlobals();});
 beforeEach(async()=>{for(const t of ['events','jobs','links','writes','contacts','conversations','audit','settings','sessions'])await store.db.query('DELETE FROM inbox_v2_'+t);vi.clearAllMocks();});
 const inbound=(id=1001,cid=101)=>({event:'message_created',id,message_type:'incoming',private:false,content:'Parking project with ANPR',account:{id:1},conversation:{id:cid,inbox_id:1},created_at:Date.now()/1000});
 it('accepts nine concurrent successful sign-ins across Core instances without exhausting the pool',async()=>{
   const second=new InboxRepository();
   vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data:{id:7,accounts:[{id:1,role:'agent'}]}}),{status:200,headers:{'content-type':'application/json','access-token':'fictional-token','client':'fictional-client','uid':'fixture@example.invalid'}})));
   try{
     const controllers=[store,second].map(db=>new InboxV2Controller(db,new Chatwoot(db),{} as any,{} as any,{} as any));
     const sessions=await Promise.all(Array.from({length:9},(_,i)=>controllers[i%2].login({email:`fixture-${i}@example.invalid`,password:'fictional-password'})));
     expect(sessions).toHaveLength(9);
     expect((await store.db.query('SELECT count(*)::int n FROM inbox_v2_sessions')).rows[0].n).toBe(9);
     expect((await store.db.query("SELECT count(*)::int n FROM inbox_v2_settings WHERE key LIKE 'login:%'")).rows[0].n).toBe(0);
   }finally{await second.onModuleDestroy();vi.unstubAllGlobals();}
 });
 it('shares failed-login limits across Core instances and normalizes the login identity',async()=>{
   const second=new InboxRepository(),login=vi.fn(async()=>{throw new UnauthorizedException();});
   try{
     const controllers=[store,second].map(db=>new InboxV2Controller(db,{login} as any,{} as any,{} as any,{} as any));
     const results=await Promise.allSettled(Array.from({length:12},(_,i)=>controllers[i%2].login({email:i%2?' FIXTURE@EXAMPLE.INVALID ':'fixture@example.invalid',password:'wrong-fixture'})));
     expect(login).toHaveBeenCalledTimes(8);
     expect(results.filter(r=>r.status==='rejected'&&r.reason.getStatus()===429)).toHaveLength(4);
     expect((await store.db.query("SELECT value FROM inbox_v2_settings WHERE key LIKE 'login:%'")).rows[0].value.count).toBe(8);
   }finally{await second.onModuleDestroy();}
 });
 it('clears failures after a successful login without blocking another operator',async()=>{
   const login=vi.fn(async(_email:string,password:string)=>{if(password==='wrong')throw new UnauthorizedException();return {userId:7};});
   const controller=new InboxV2Controller(store,{login} as any,{} as any,{} as any,{} as any);
   for(let i=0;i<7;i++)await expect(controller.login({email:'fixture@example.invalid',password:'wrong'})).rejects.toThrow();
   await expect(controller.login({email:'another@example.invalid',password:'right'})).resolves.toMatchObject({userId:7});
   await expect(controller.login({email:'fixture@example.invalid',password:'right'})).resolves.toMatchObject({userId:7});
   await expect(controller.login({email:'fixture@example.invalid',password:'wrong'})).rejects.toThrow();
   expect((await store.db.query("SELECT value FROM inbox_v2_settings WHERE key LIKE 'login:%'")).rows[0].value.count).toBe(1);
 });
 it('does not turn an authentication dependency outage into a failed-password lockout',async()=>{
   const login=vi.fn(async()=>{throw new ServiceUnavailableException();});
   const controller=new InboxV2Controller(store,{login} as any,{} as any,{} as any,{} as any);
   for(let i=0;i<9;i++)await expect(controller.login({email:'fixture@example.invalid',password:'right'})).rejects.toThrow(ServiceUnavailableException);
   expect(login).toHaveBeenCalledTimes(9);
   expect((await store.db.query("SELECT count(*)::int n FROM inbox_v2_settings WHERE key LIKE 'login:%'")).rows[0].n).toBe(0);
 });
 it('expires old failure counters so a previously limited operator can retry',async()=>{
   const key='login:'+store.identity('fixture@example.invalid');
   await store.db.query("INSERT INTO inbox_v2_settings(account_id,key,value) VALUES(1,$1,jsonb_build_object('count',8,'at',(EXTRACT(EPOCH FROM clock_timestamp())*1000-61000)::bigint))",[key]);
   const login=vi.fn(async()=>({userId:7}));
   const controller=new InboxV2Controller(store,{login} as any,{} as any,{} as any,{} as any);
   await expect(controller.login({email:'fixture@example.invalid',password:'right'})).resolves.toMatchObject({userId:7});
   expect(login).toHaveBeenCalledOnce();
 });
 it('serves only requested CRM links through authenticated internal reads without writing OKKI',async()=>{
   await service.ingest(inbound());const c=(await store.conversation(101))!;
   await store.db.query('INSERT INTO inbox_v2_links(account_id,group_key,company_id,snapshot) VALUES(1,$1,$2,$3)',[c.group_key,'55',store.pack({company:{name:'Fictional Company',trail_status:{status_name:'Following'},owner:[{nickname:'Fixture owner'}],private_field:'DO_NOT_EXPOSE'},opportunities:[]})]);
   const controller=new InboxV2Controller(store,cw,service,{} as any,{} as any),request={headers:{'x-inbox-key':'isolated-test-key'}} as any;
   const external=vi.spyOn(okki,'request');
   await expect(controller.customerData({accountId:1,contactIds:[1]},{headers:{}} as any)).rejects.toThrow();
   await expect(controller.customerData({accountId:2,contactIds:[1]},request)).rejects.toThrow();
   expect(await controller.customerData({accountId:1,contactIds:[999]},request)).toEqual({records:[]});
   const result=await controller.customerData({accountId:1,contactIds:[1]},request);
   expect(result.records).toHaveLength(1);expect(result.records[0]).toMatchObject({companyId:'55',name:'Fictional Company',stage:'Following',owner:'Fixture owner'});
   expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE');expect(external).not.toHaveBeenCalled();external.mockRestore();
 });
 it('replays one event concurrently without duplicate jobs',async()=>{await Promise.all([service.ingest(inbound()),service.ingest(inbound())]);expect((await store.db.query('SELECT count(*)::int n FROM inbox_v2_events')).rows[0].n).toBe(1);expect((await store.db.query('SELECT count(*)::int n FROM inbox_v2_jobs')).rows[0].n).toBe(2);});
 it.each([false,true])('reopens resolved office reception while preserving an explicit pause=%s',async(manualPause)=>{
   vi.stubEnv('INBOX_OFFICE_RECEPTION','true');vi.stubEnv('INBOX_MODEL_READY','true');
   cw.reception=vi.fn(async()=>({mode:'ai',onlineCount:0,assigneeId:null}));
   try {
     await service.ingest(inbound());
     cw.account.mockResolvedValueOnce({...native(101),status:'resolved'});
     await service.ingest({event:'conversation_status_changed',id:101,inbox_id:1,account:{id:1},status:'resolved'});
     expect((await store.conversation(101))!.mode).toBe('paused');
     if(manualPause)await service.control(101,{action:'pause',expectedRevision:(await store.conversation(101))!.revision,idempotencyKey:'explicit-office-pause'},actor);
     await service.ingest({...inbound(1002),created_at:1});
     expect((await store.conversation(101))!.mode).toBe('paused');
     await service.ingest(inbound(1003));
     expect((await store.conversation(101))!.mode).toBe(manualPause?'paused':'ai');
     expect((await store.db.query("SELECT count(*)::int n FROM inbox_v2_jobs WHERE kind='ai' AND state='pending'")).rows[0].n).toBe(manualPause?0:1);
   } finally {vi.unstubAllEnvs();delete cw.reception;}
 });
 it('keeps offline form submissions in the human callback queue without model or send jobs',async()=>{
   cw.account.mockResolvedValueOnce({...native(101),additional_attributes:{ake_offline_submission:true}});
   expect(await service.ingest(inbound())).toMatchObject({accepted:true,offlineCallback:true});
   expect((await store.conversation(101))!.mode).toBe('human_pending');
   expect((await store.db.query('SELECT count(*)::int n FROM inbox_v2_jobs')).rows[0].n).toBe(0);
   expect(cw.send).not.toHaveBeenCalled();
 });
 it('indexes newly bound personal channels for CRM while keeping reception human',async()=>{
   cw.account.mockResolvedValueOnce({id:4,channel_type:'Channel::Api',auto_assignment_config:{ake_owner_id:7},additional_attributes:{ake_instance:'ake-seat-7'}})
     .mockResolvedValueOnce({...native(101),inbox_id:4});
   expect(await service.ingest({...inbound(),conversation:{id:101,inbox_id:4}})).toMatchObject({accepted:true});
   expect((await store.conversation(101))!.mode).toBe('human');
   expect((await store.db.query('SELECT kind FROM inbox_v2_jobs')).rows).toEqual([{kind:'okki'}]);
   expect(cw.send).not.toHaveBeenCalled();
   await expect(service.control(101,{action:'resume',expectedRevision:(await store.conversation(101))!.revision,idempotencyKey:'personal-resume-test'},actor)).rejects.toThrow('个人渠道');
 });
 it('does not accept personal-channel metadata from the webhook payload alone',async()=>{
   cw.account.mockResolvedValueOnce({id:4,channel_type:'Channel::Api',auto_assignment_config:{}});
   expect(await service.ingest({...inbound(),conversation:{id:101,inbox_id:4,auto_assignment_config:{ake_owner_id:7}}})).toEqual({accepted:false});
   expect((await store.db.query('SELECT count(*)::int n FROM inbox_v2_jobs')).rows[0].n).toBe(0);
 });
 it('takeover cancels a model already generating and a queued reply; only explicit resume reopens',async()=>{await service.ingest(inbound());const model=await store.claim(['ai']);expect(model).toBeTruthy();const c=(await store.conversation(101))!;await store.job('send','queued',101,c.group_key,c.revision,{text:'Must not send'});const command={action:'takeover',expectedRevision:c.revision,idempotencyKey:'takeover-test'};const [one,two]=await Promise.all([service.control(101,command,actor),service.control(101,command,actor)]);expect(one).toEqual(two);expect((await store.conversation(101))!.mode).toBe('human');expect(await store.claim(['send'])).toBeUndefined();await service.ingest(inbound(1002));expect((await store.conversation(101))!.mode).toBe('human');const latest=(await store.conversation(101))!;await service.control(101,{action:'resume',expectedRevision:latest.revision,idempotencyKey:'resume-test'},actor);expect((await store.conversation(101))!.mode).toBe('ai');expect((await store.db.query("SELECT count(*)::int n FROM inbox_v2_jobs WHERE kind IN ('send','ai') AND state='pending'")).rows[0].n).toBe(0);});
 it('a reply on a linked channel cancels even a claimed followup',async()=>{await service.ingest(inbound());await service.ingest(inbound(1002,102));const c=(await store.conversation(101))!;await store.job('followup','follow',101,c.group_key,c.revision,{text:'Never submit'});const job=(await store.claim(['followup']))!;await service.ingest(inbound(1003,102));await service.send(job);expect(cw.send).not.toHaveBeenCalled();expect((await store.db.query("SELECT state FROM inbox_v2_jobs WHERE id='follow'")).rows[0].state).toBe('cancelled');});
 it('blocking covers verified identities and unblocking never replays',async()=>{await service.ingest(inbound());await service.ingest(inbound(1002,102));const c=(await store.conversation(101))!;await service.setGroupBlock(c.group_key,true,'7');expect((await service.admission(102)).allowed).toBe(false);await service.setGroupBlock(c.group_key,false,'7');expect((await store.conversation(102))!.mode).toBe('human');expect((await store.db.query("SELECT count(*)::int n FROM inbox_v2_jobs WHERE kind='ai' AND state='pending'")).rows[0].n).toBe(0);});
 it('a completed model response cannot queue a reply after takeover during generation',async()=>{
   await service.ingest(inbound());const c=(await store.conversation(101))!,job=(await store.claim(['ai']))!;
   cw.messages.mockResolvedValueOnce([{id:1001,message_type:'incoming',content:'Parking project with ANPR'}]);
   vi.spyOn(service,'retrieve').mockResolvedValueOnce([{id:'approved',body:'approved',version:1,tags:{}}]);
   let finish:(value:any)=>void=()=>{};let entered:()=>void=()=>{};const ready=new Promise<void>(r=>entered=r);
   vi.stubGlobal('fetch',vi.fn(()=>{entered();return new Promise(r=>finish=r);}));
   const generation=service.analyze(job);await ready;
   await service.control(101,{action:'takeover',expectedRevision:c.revision,idempotencyKey:'during-model'},actor);
   finish(new Response(JSON.stringify({mode:'api',reply:'Where is the project?',fields:emptyProfile().fields,evidence:[],knowledgeIds:[],askedFields:['projectLocation'],summary:'Project location missing',needsHuman:false}),{status:200,headers:{'content-type':'application/json'}}));
   await generation;expect((await store.db.query("SELECT count(*)::int n FROM inbox_v2_jobs WHERE kind='send'")).rows[0].n).toBe(0);vi.unstubAllGlobals();
 });
 it('holds native delivery failures and cancels followups for the undelivered question',async()=>{
   await service.ingest(inbound());const c=(await store.conversation(101))!;await store.job('send','reply:test',101,c.group_key,c.revision,{text:'Question?'});await store.finish('reply:test','sent',{messageId:900});await store.job('followup','followup:reply:test:0',101,c.group_key,c.revision,{});
   await service.ingest({...inbound(900),event:'message_updated',message_type:'outgoing',status:'failed',content_attributes:{ake_inbox_job:'reply:test'}});
   expect((await store.db.query("SELECT state,error FROM inbox_v2_jobs WHERE id='reply:test'")).rows[0]).toEqual({state:'review',error:'native_delivery_failed'});expect((await store.db.query("SELECT state FROM inbox_v2_jobs WHERE id='followup:reply:test:0'")).rows[0].state).toBe('cancelled');expect((await store.conversation(101))!.mode).toBe('human_pending');
 });
 it('pauses uncertain side effects on restart, while model work is recoverable',async()=>{await store.job('send','uncertain-send',101,'g',0,{});await store.job('ai','model',101,'g',0,{});await store.db.query("UPDATE inbox_v2_jobs SET state='processing',claimed_at=now()-interval '6 minutes'");await store.recover();const states=(await store.db.query('SELECT id,state FROM inbox_v2_jobs ORDER BY id')).rows;expect(states).toEqual([{id:'model',state:'pending'},{id:'uncertain-send',state:'review'}]);});
 it('never repeats a POST after a lost CRM response, including a fresh writer',async()=>{const post=vi.spyOn(okki,'request').mockRejectedValue(new Error('timeout'));await expect(okki.write('intent','lead','/v1/lead/push',{name:'test'},'lead_id')).rejects.toBeInstanceOf(UncertainWrite);const restarted=new OkkiWriter(store),post2=vi.spyOn(restarted,'request');await expect(restarted.write('intent','lead','/v1/lead/push',{name:'test'},'lead_id')).rejects.toBeInstanceOf(UncertainWrite);expect(post).toHaveBeenCalledTimes(1);expect(post2).not.toHaveBeenCalled();});
 it('reuses a confirmed CRM receipt across parallel duplicate requests',async()=>{vi.spyOn(okki,'request').mockResolvedValue({lead_id:44});expect(await okki.write('created','lead','/v1/lead/push',{name:'test'},'lead_id')).toBe('44');expect(await new OkkiWriter(store).write('created','lead','/v1/lead/push',{name:'test'},'lead_id')).toBe('44');});
 it('exports both historical pending snapshots and the later original attachment',async()=>{
   const root=await mkdtemp(join(tmpdir(),'inbox-archive-test-'));process.env.INBOX_ARCHIVE_ROOT=root;
   const bytes=Buffer.from([0,255,1,2,10,13]);const sha=createHash('sha256').update(bytes).digest('hex');await mkdir(join(root,'blobs',sha.slice(0,2)),{recursive:true});await writeFile(join(root,'blobs',sha.slice(0,2),sha),bytes);await mkdir(join(root,'messages','99'),{recursive:true});
   for(const attachment of [{id:5,archive_pending:true},{id:5,file:{sha256:sha}}]){const data=Buffer.from(JSON.stringify({record:{account_id:1,conversation_id:101,private:false},attachments:[attachment]}));await writeFile(join(root,'messages','99',createHash('sha256').update(data).digest('hex')+'.json'),data);}
   const files:Record<string,Buffer>={};await new InboxExports(store,cw).addVersions(files,101,99,false);expect(files['blobs/'+sha]).toEqual(bytes);expect(Object.keys(files).length).toBe(3);await rm(root,{recursive:true,force:true});delete process.env.INBOX_ARCHIVE_ROOT;
 });
 it('enforces the account stage date and exchange-rate requirements before writing',async()=>{
   const writer=new OkkiWriter(store);vi.spyOn(writer,'dictionaries').mockResolvedValue({users:[{id:'50'}],flows:[{id:'30'}],businessTypes:[{id:'0'}],fields:[]} as any);vi.spyOn(writer,'stages').mockResolvedValue([{id:'40',requiredFields:['account_date','exchange_rate']}]);
   await expect(writer.validateSelections(opportunitySchema.parse(project))).rejects.toThrow('日期');await expect(writer.validateSelections(opportunitySchema.parse({...project,closeDate:'2026-12-31'}))).rejects.toThrow('汇率');await expect(writer.validateSelections(opportunitySchema.parse({...project,closeDate:'2026-12-31',exchangeRate:700}))).resolves.toBeUndefined();
 });
 it('retains deleted public messages and excludes archived private notes',async()=>{
   const root=await mkdtemp(join(tmpdir(),'inbox-deleted-test-'));process.env.INBOX_ARCHIVE_ROOT=root;
   for(const [id,privateNote]of [[11,false],[12,true]] as const){await mkdir(join(root,'messages',String(id)),{recursive:true});const bytes=Buffer.from(JSON.stringify({record:{id,account_id:1,conversation_id:301,private:privateNote,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z',content:privateNote?'INTERNAL':'Original deleted public message'},attachments:[]}));await writeFile(join(root,'messages',String(id),createHash('sha256').update(bytes).digest('hex')+'.json'),bytes);}
   const files:Record<string,Buffer>={};const records=await new InboxExports(store,cw).addArchivedMessages(files,101,301,{includePrivate:false},new Set());expect(records.map(r=>r.id)).toEqual([11]);expect(Buffer.concat(Object.values(files)).toString()).not.toContain('INTERNAL');await rm(root,{recursive:true,force:true});delete process.env.INBOX_ARCHIVE_ROOT;
 });
 it('rejects fabricated and expired operator sessions',async()=>{const chatwoot=new Chatwoot(store);await expect(chatwoot.actor('x'.repeat(64))).rejects.toThrow();await expect(chatwoot.actor('a'.repeat(64))).rejects.toThrow();});
});
