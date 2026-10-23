import { Controller, Get, Post, Body, Param, Req, Res, UnauthorizedException, ForbiddenException, ServiceUnavailableException, ConflictException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { InboxRepository } from './repository';
import { Chatwoot, secretEquals } from './chatwoot';
import { InboxAutomation } from './automation.service';
import { InboxExports } from './exports';
import { z } from 'zod';
import { MarketingService } from '../marketing/service';
import { config, opportunitySchema, knowledgeSchema, fieldsSchema, createCustomerSchema, type Actor } from './contracts';

@Controller('api/v1/inbox-v2')
export class InboxV2Controller {
  private attempts=new Map<string,{count:number;at:number}>();
  constructor(private readonly store:InboxRepository,private readonly cw:Chatwoot,private readonly automation:InboxAutomation,private readonly exports:InboxExports,private readonly marketing:MarketingService){}
  private ready(){if(!config().enabled)throw new ServiceUnavailableException('Inbox v0.2 is disabled');}
  private actor(req:Request){this.ready();return this.cw.actor(String(req.headers['x-inbox-session']||''));}
  private internal(req:Request){this.ready();if(!secretEquals(String(req.headers['x-inbox-key']||''),config().internalKey))throw new UnauthorizedException();}
  private admin(actor:Actor){if(actor.role!=='administrator')throw new ForbiddenException('Administrator access required');}
  @Post('session')
  async login(@Body() b:any,@Req() req:Request){
    this.ready();const key=req.ip||'unknown',old=this.attempts.get(key);
    if(old&&Date.now()-old.at<60000&&old.count>=8)throw new UnauthorizedException('Too many sign-in attempts');
    this.attempts.set(key,{count:old&&Date.now()-old.at<60000?old.count+1:1,at:Date.now()});
    for(const [ip,v]of this.attempts)if(Date.now()-v.at>60000)this.attempts.delete(ip);
    return this.cw.login(String(b.email||''),String(b.password||''));
  }
  @Get('session') async me(@Req() req:Request){const a=await this.actor(req);return {userId:a.userId,role:a.role,accountId:a.accountId};}
  @Post('logout') async logout(@Req() req:Request){
    const a=await this.actor(req);await this.store.db.query('DELETE FROM inbox_v2_sessions WHERE account_id=$1 AND token_hash=$2',[a.accountId,createHash('sha256').update(String(req.headers['x-inbox-session']||'')).digest('hex')]);return {ok:true};
  }
  @Post('events') async events(@Body() b:any,@Req() req:Request){this.internal(req);const result=await this.automation.ingest(b);if(process.env.MARKETING_ENABLED==='true')await this.marketing.observeInbound(b);return result;}
  @Post('admission') async admission(@Body() b:any,@Req() req:Request){
    this.internal(req);if(Number(b.accountId)!==config().accountId)return {allowed:false};
    let managedBridge=false;
    if(b.provider==='evolution'&&process.env.MARKETING_ENABLED==='true'){
      const c=await this.store.conversation(Number(b.conversationId));if(!c)return {allowed:false};
      const owner=(await this.store.db.query('SELECT provider FROM marketing_bridge_owners WHERE account_id=$1 AND inbox_id=$2',[config().accountId,c.inbox_id])).rows[0];
      managedBridge=!!owner;if(owner&&owner.provider!=='evolution')return {allowed:false,reason:'bridge_not_owner',managedBridge};
    }
    return {...await this.automation.admission(Number(b.conversationId),b.jobId,b.revision),managedBridge};
  }
  @Post('human-reply') human(@Body() b:any,@Req() req:Request){this.internal(req);if(Number(b.accountId)!==config().accountId)throw new ForbiddenException();return this.automation.nativeHuman(Number(b.conversationId));}
  @Post('native-block') async nativeBlock(@Body() b:any,@Req() req:Request){
    this.internal(req);if(Number(b.accountId)!==config().accountId||typeof b.blocked!=='boolean')throw new ForbiddenException();
    const c=(await this.store.db.query('SELECT group_key FROM inbox_v2_contacts WHERE account_id=$1 AND contact_id=$2',[config().accountId,Number(b.contactId)])).rows[0];
    if(c)await this.automation.setGroupBlock(c.group_key,b.blocked,'chatwoot');return {ok:true};
  }
  @Post('channel-health') async health(@Body() b:any,@Req() req:Request){this.internal(req);await this.store.db.query("INSERT INTO inbox_v2_settings(account_id,key,value) VALUES($1,'channel_health',$2) ON CONFLICT(account_id,key) DO UPDATE SET value=excluded.value",[config().accountId,b]);return {ok:true};}
  // The native Inbox checks seat ownership before requesting these CRM views.
  // This endpoint only reads OKKI and refreshes the existing local snapshot.
  @Post('customer-data') async customerData(@Body() body:unknown,@Req() req:Request){
    this.internal(req);
    const b=z.object({accountId:z.number().int(),contactIds:z.array(z.number().int().positive()).max(50),refresh:z.boolean().optional()}).parse(body);
    if(b.accountId!==config().accountId)throw new ForbiddenException();
    if(b.refresh&&b.contactIds.length!==1)throw new ConflictException('Refresh one customer at a time');
    let rows=(await this.store.db.query(`SELECT c.contact_id,l.group_key,l.lead_id,l.company_id,l.refreshed_at,l.snapshot
      FROM inbox_v2_contacts c JOIN inbox_v2_links l USING(account_id,group_key)
      WHERE c.account_id=$1 AND c.contact_id=ANY($2::bigint[])`,[b.accountId,b.contactIds])).rows;
    if(b.refresh&&rows[0]){
      await this.automation.okki.refresh(rows[0].group_key);
      rows=(await this.store.db.query(`SELECT c.contact_id,l.group_key,l.lead_id,l.company_id,l.refreshed_at,l.snapshot
        FROM inbox_v2_contacts c JOIN inbox_v2_links l USING(account_id,group_key)
        WHERE c.account_id=$1 AND c.contact_id=ANY($2::bigint[])`,[b.accountId,b.contactIds])).rows;
    }
    const records=[];
    for(const row of rows){
      const snapshot=this.store.unpack(row.snapshot)||{},company=snapshot.company||{},lead=snapshot.lead||{};
      let followups:any[]=[],followupsAvailable=false;
      if(b.refresh&&(row.company_id||row.lead_id)){
        const query=new URLSearchParams({count:'30',start_index:'1',...(row.company_id?{company_id:String(row.company_id)}:{lead_id:String(row.lead_id)})});
        try{const data=await this.automation.okki.request('/v1/dynamic/trail/list?'+query);followups=(data?.list||[]).slice(0,30).map((t:any)=>({id:t.trail_id,content:String(t.content||''),createdAt:t.create_time||t.created_at,author:t.create_user_info?.nickname||t.user_info?.full_name||''}));followupsAvailable=true;}catch{/* Detail remains readable if this optional API is unavailable. */}
      }
      records.push({contactId:Number(row.contact_id),companyId:row.company_id,leadId:row.lead_id,refreshedAt:row.refreshed_at,
        name:company.name||lead.name||'',stage:company.trail_status?.status_name||company.trail_status_name||company.stage_info?.name||'',owner:(company.owner||[]).map((u:any)=>u.nickname||u.full_name||'').filter(Boolean).join('、')||company.main_user_info?.full_name||lead.main_user_info?.full_name||'',
        opportunities:(snapshot.opportunities||[]).map((o:any)=>({id:o.opportunity_id,name:o.name,stage:o.stage_info?.name||'',amount:o.amount,currency:o.currency})),
        followups,followupsAvailable});
    }
    return {records};
  }
  @Get('status') async status(@Req() req:Request){
    const a=await this.actor(req),inboxes:any=await this.cw.account('/inboxes',undefined,'GET',a.credentials);
    const jobs=await this.store.db.query('SELECT kind,state,count(*)::int count FROM inbox_v2_jobs WHERE account_id=$1 GROUP BY kind,state',[a.accountId]);
    const health=(await this.store.db.query("SELECT value FROM inbox_v2_settings WHERE account_id=$1 AND key='channel_health'",[a.accountId])).rows[0]?.value||{};
    return {version:'0.2.0',controlledTrial:config().testContacts.length>0,autoSend:config().autoSend,okkiWrite:config().okkiWrite,effectiveFrom:config().effectiveFrom,
      channels:(inboxes.payload||[]).filter((i:any)=>config().channels[String(i.id)]).map((i:any)=>({id:i.id,name:i.name,channel:config().channels[String(i.id)],configured:true,acceptance:health[i.id]?.acceptance||'not_verified_by_configuration',connection:health[i.id]?.connection||'not_checked',checkedAt:health[i.id]?.checkedAt,autoEnabled:config().autoChannels.includes(config().channels[String(i.id)]),imapEnabled:i.imap_enabled,smtpEnabled:i.smtp_enabled})),jobs:jobs.rows};
  }
  @Get('conversations') async list(@Req() req:Request){
    const a=await this.actor(req);const rows=(await this.store.db.query(`SELECT v.conversation_id,v.channel,v.mode,v.revision,v.native_status,v.updated_at,c.blocked,c.opted_out FROM inbox_v2_conversations v JOIN inbox_v2_contacts c USING(account_id,contact_id) WHERE v.account_id=$1 ORDER BY v.updated_at DESC LIMIT 100`,[a.accountId])).rows;
    if(a.role==='administrator')return rows;
    const permitted=[];for(const r of rows){try{await this.cw.allowed(a,Number(r.conversation_id));permitted.push(r);}catch{/* no existence leakage */}}
    return permitted;
  }
  @Get('conversations/:id') async conversation(@Param('id') id:string,@Req() req:Request){
    const a=await this.actor(req),native=await this.cw.allowed(a,Number(id)),c=await this.store.conversation(Number(id));
    if(!c)return {indexed:false,conversationId:Number(id),nativeStatus:native.status};
    const jobs=(await this.store.db.query('SELECT id,kind,state,error,result,due_at FROM inbox_v2_jobs WHERE account_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT 40',[a.accountId,id])).rows;
    const links=(await this.store.db.query('SELECT lead_id,company_id,customer_ids,refreshed_at,snapshot FROM inbox_v2_links WHERE account_id=$1 AND group_key=$2',[a.accountId,c.group_key])).rows[0];
    const timeline=[];
    for(const row of (await this.store.db.query('SELECT v.conversation_id,v.channel,v.mode FROM inbox_v2_conversations v JOIN inbox_v2_contacts c USING(account_id,contact_id) WHERE v.account_id=$1 AND c.group_key=$2 ORDER BY v.updated_at DESC',[a.accountId,c.group_key])).rows){try{await this.cw.allowed(a,Number(row.conversation_id));timeline.push(row);}catch{}}
    return {indexed:true,conversationId:Number(id),channel:c.channel,mode:c.mode,revision:c.revision,blocked:c.blocked,optedOut:c.opted_out,timezone:c.timezone,profile:this.store.unpack(c.profile),summary:this.store.unpack(c.summary),nativeStatus:c.native_status,
      contact:{id:c.contact_id,name:native.meta?.sender?.name},attachments:(await this.cw.messages(Number(id),a.credentials)).filter((m:any)=>!m.private).flatMap((m:any)=>m.attachments||[]),
      jobs,links:links?{...links,snapshot:this.store.unpack(links.snapshot)}:null,timeline};
  }
  @Post('conversations/:id/control') async control(@Param('id') id:string,@Body() b:unknown,@Req() req:Request){return this.automation.control(Number(id),b,await this.actor(req));}
  @Post('conversations/:id/profile') async profile(@Param('id') id:string,@Body() b:any,@Req() req:Request){
    const actor=await this.actor(req);await this.cw.allowed(actor,Number(id));const fields=fieldsSchema.parse(b.fields);
    const c=await this.store.conversation(Number(id));if(!c)throw new ConflictException('Conversation not indexed');
    if(typeof b.idempotencyKey!=='string'||b.idempotencyKey.length<8)throw new ConflictException('An operation key is required');
    return this.store.actionOnce('profile:'+actor.userId+':'+b.idempotencyKey,createHash('sha256').update(JSON.stringify({id,b})).digest('hex'),async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['inbox-v2:group:'+c.group_key]);
      const latest=(await this.store.conversation(Number(id),db))!;if(latest.revision!==b.expectedRevision)throw new ConflictException('Refresh before saving');
      const p=this.store.unpack(latest.profile),oldFields=p.fields;p.fields=fields;p.confirmed=Object.keys(fields).filter(k=>((fields as any)[k]===null&&oldFields?.[k]!=null)||(Array.isArray((fields as any)[k])&&!(fields as any)[k].length&&oldFields?.[k]?.length)||((fields as any)[k]!==null&&(!Array.isArray((fields as any)[k])||(fields as any)[k].length)));
      await db.query('UPDATE inbox_v2_conversations SET profile=$3,revision=revision+1 WHERE account_id=$1 AND conversation_id=$2',[actor.accountId,id,this.store.pack(p)]);
      if(b.timezone!==undefined){if(b.timezone)try{new Intl.DateTimeFormat('en',{timeZone:b.timezone}).format();}catch{throw new ConflictException('Use a valid IANA timezone');}
        await db.query('UPDATE inbox_v2_contacts SET timezone=$3 WHERE account_id=$1 AND group_key=$2',[actor.accountId,c.group_key,b.timezone||null]);}
      await this.store.cancel(c.group_key,'profile_reviewed',db,Number(id));await this.store.audit(String(actor.userId),'profile.reviewed',id,{fields:p.confirmed},db);return {ok:true};
    });
  }
  @Post('conversations/:id/customer') async customer(@Param('id') id:string,@Body() b:any,@Req() req:Request){
    const a=await this.actor(req);await this.cw.allowed(a,Number(id));
    const input=z.object({confirmed:z.literal(true),idempotencyKey:z.string().min(8),ownerId:z.string().regex(/^\d+$/),createCustomer:createCustomerSchema}).parse(b);
    const c=await this.store.conversation(Number(id));if(!c)throw new ConflictException();
    if(!config().okkiWrite)throw new ConflictException('OKKI writes are disabled');
    if((await this.store.db.query('SELECT identity_conflict FROM inbox_v2_contacts WHERE account_id=$1 AND contact_id=$2',[a.accountId,c.contact_id])).rows[0]?.identity_conflict)throw new ConflictException('Resolve the identity conflict before writing CRM');
    const dict=await this.automation.okki.dictionaries();if(!dict.users.some((u:any)=>u.id===input.ownerId))throw new ConflictException('Select an active OKKI owner');
    const result=await this.automation.okki.customer(c.group_key,Number(id),{...input,contactIds:[]},this.store.unpack(c.contact_profile));
    await this.store.audit(String(a.userId),'customer.confirmed',id,{companyId:result.companyId});await this.automation.okki.refresh(c.group_key);return result;
  }
  @Post('conversations/:id/opportunity') async opportunity(@Param('id') id:string,@Body() body:unknown,@Req() req:Request){
    const a=await this.actor(req);await this.cw.allowed(a,Number(id));const input=opportunitySchema.parse(body),c=await this.store.conversation(Number(id));
    if(!c)throw new ConflictException('Conversation not indexed');
    if((await this.store.db.query('SELECT identity_conflict FROM inbox_v2_contacts WHERE account_id=$1 AND contact_id=$2',[a.accountId,c.contact_id])).rows[0]?.identity_conflict)throw new ConflictException('Resolve the identity conflict before creating an opportunity');
    if(!config().okkiWrite)throw new ConflictException('OKKI writes are disabled');
    await this.automation.okki.validateSelections(input);
    const stable={...input,idempotencyKey:'per-conversation',reconcileExisting:false};
    const jobId='opportunity:'+id,hash=createHash('sha256').update(JSON.stringify(stable)).digest('hex');
    return this.store.transaction('opportunity:'+id,async db=>{
      const existing=(await db.query('SELECT * FROM inbox_v2_jobs WHERE id=$1',[jobId])).rows[0];
      if(existing){
        const same=createHash('sha256').update(JSON.stringify({...this.store.unpack(existing.payload),idempotencyKey:'per-conversation',reconcileExisting:false})).digest('hex')===hash;
        if(input.reconcileExisting&&existing.state==='review'){
          this.admin(a);
          const prior=(await db.query('SELECT * FROM inbox_v2_writes WHERE account_id=$1 AND operation_key=$2 FOR UPDATE',[a.accountId,jobId])).rows[0];
          if(prior?.remote_id)throw new ConflictException('已存在商机回执，请继续未完成步骤，不要新建。');
          if(prior&&Date.now()-new Date(prior.updated_at).getTime()<300000)throw new ConflictException('请等待写入结果稳定后再核查（五分钟）。');
          const observed=await this.automation.okki.findConversationOpportunities(Number(id));
          if(observed.length)throw new ConflictException('OKKI 已存在来源对应的商机，请核对已有记录，不得重新创建。');
          await this.store.audit(String(a.userId),'opportunity.absence_confirmed',id,{previousHash:prior?.request_hash,previousReceipt:prior?.receipt,matchedRecords:0},db);
          if(prior)await db.query("UPDATE inbox_v2_writes SET state='reconciled_absent',receipt=$3 WHERE account_id=$1 AND operation_key=$2",[a.accountId,jobId,{operatorConfirmed:true,actor:a.userId,matchedRecords:0}]);
          await db.query("UPDATE inbox_v2_jobs SET payload=$2,state='pending',error=null,due_at=now() WHERE id=$1",[jobId,this.store.pack(input)]);return {id:jobId,state:'pending',reconciled:true};
        }
        if(!same)throw new ConflictException('An opportunity operation already exists. Reconcile it before changing the request.');return {id:existing.id,state:existing.state,result:existing.result};
      }
      await this.store.job('opportunity',jobId,Number(id),c.group_key,c.revision,input,new Date(),db);await this.store.audit(String(a.userId),'opportunity.confirmed',id,{requiredFields:['projectLocation','products','estimatedAmount','currency']},db);return {id:jobId,state:'pending'};
    });
  }
  @Post('conversations/:id/refresh') async refresh(@Param('id') id:string,@Req() req:Request){
    const a=await this.actor(req);await this.cw.allowed(a,Number(id));const c=await this.store.conversation(Number(id));if(!c)throw new ConflictException();
    return this.automation.okki.refresh(c.group_key);
  }
  @Get('conversations/:id/customers') async customers(@Param('id') id:string,@Req() req:Request){
    const a=await this.actor(req),c=await this.cw.allowed(a,Number(id)),contact=c.meta.sender;
    const match=await this.automation.okki.findCompany(String(contact.email||''),String(contact.phone_number||''));
    return match?[{id:match[0],name:match[1].name}]:[];
  }
  @Post('conversations/:id/retry') async retry(@Param('id') id:string,@Body() b:any,@Req() req:Request){
    const a=await this.actor(req);await this.cw.allowed(a,Number(id));
    const c=await this.store.conversation(Number(id));if(!c)throw new ConflictException();
    await this.automation.okki.refresh(c.group_key);
    // Confirmed step IDs are reused. An uncertain POST remains held for reconciliation.
    const r=await this.store.db.query("UPDATE inbox_v2_jobs SET state='pending',due_at=now() WHERE id=$1 AND conversation_id=$2 AND account_id=$3 AND kind='opportunity' AND state='review' RETURNING id",[b.jobId,id,a.accountId]);
    await this.store.audit(String(a.userId),'opportunity.retry',id,{});return {queued:!!r.rowCount};
  }
  @Post('conversations/:id/link') async link(@Param('id') id:string,@Body() b:any,@Req() req:Request){
    return this.automation.linkIdentity(await this.actor(req),{...b,conversationId:Number(id),otherConversationId:Number(b.conversationId)});
  }
  @Get('okki/dictionaries') async dictionaries(@Req() req:Request){
    await this.actor(req);const o=this.automation.okki;
    return o.dictionaries();
  }
  @Get('okki/stages/:flow') async stages(@Param('flow') flow:string,@Req() req:Request){await this.actor(req);if(!/^\d+$/.test(flow))throw new ForbiddenException();return this.automation.okki.stages(flow);}
  @Get('knowledge') async knowledge(@Req() req:Request){await this.actor(req);return (await this.store.db.query('SELECT * FROM inbox_v2_knowledge ORDER BY created_at DESC LIMIT 500')).rows;}
  @Post('knowledge') async createKnowledge(@Body() body:unknown,@Req() req:Request){
    const a=await this.actor(req);this.admin(a);const b=knowledgeSchema.parse(body),id=b.id||this.store.id('kb');
    return this.store.transaction('knowledge:'+id,async db=>{
      const version=Number((await db.query('SELECT COALESCE(max(version),0)+1 AS v FROM inbox_v2_knowledge WHERE id=$1',[id])).rows[0].v);
      await db.query('INSERT INTO inbox_v2_knowledge(id,version,title,body,source_id,source_hash,tags) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,version,b.title,b.body,b.sourceId,b.sourceHash,b.tags]);
      await this.store.audit(String(a.userId),'knowledge.draft',id,{version},db);return {id,version,state:'draft'};
    });
  }
  @Post('knowledge/:id/review') async review(@Param('id') id:string,@Body() b:any,@Req() req:Request){
    const a=await this.actor(req);this.admin(a);if(!['approved','retired'].includes(b.state)||!Number.isSafeInteger(b.version))throw new ConflictException('Invalid knowledge review');
    await this.store.transaction('knowledge:'+id,async db=>{
      if(b.state==='approved')await db.query("UPDATE inbox_v2_knowledge SET state='retired' WHERE id=$1 AND state='approved'",[id]);
      const r=await db.query('UPDATE inbox_v2_knowledge SET state=$3,reviewed_by=$4,reviewed_at=now() WHERE id=$1 AND version=$2 RETURNING id',[id,b.version,b.state,String(a.userId)]);if(!r.rowCount)throw new ConflictException('Knowledge version missing');
      await this.store.audit(String(a.userId),'knowledge.'+b.state,id,{version:b.version},db);
    });return {ok:true};
  }
  @Post('exports') async export(@Body() body:unknown,@Req() req:Request){return this.exports.create(body,await this.actor(req));}
  @Get('exports/:id') async exportStatus(@Param('id') id:string,@Req() req:Request){const r=await this.exports.get(id,await this.actor(req));return {id:r.id,state:r.state,format:r.format,sha256:r.sha256,error:r.error,expiresAt:r.expires_at};}
  @Get('exports/:id/download') async download(@Param('id') id:string,@Req() req:Request,@Res() res:Response){
    const a=await this.actor(req),row=await this.exports.get(id,a);if(row.state!=='ready')throw new ConflictException('Export is not ready');
    if(!/^export_[a-f0-9-]+\.(pdf|csv|xlsx|zip)$/.test(row.file_name))throw new ForbiddenException();
    await this.store.audit(String(a.userId),'export.downloaded',id);res.set({'content-type':'application/octet-stream','content-disposition':`attachment; filename="${row.file_name}"`,'cache-control':'no-store'});res.send(await readFile(join(config().exportRoot,row.file_name)));
  }
}
