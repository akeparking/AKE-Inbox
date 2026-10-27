import { Injectable, OnApplicationBootstrap, OnModuleDestroy, ConflictException, BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { InboxRepository } from './repository';
import { Chatwoot } from './chatwoot';
import { InboxExports } from './exports';
import { OkkiWriter, UncertainWrite } from './okki';
import { config, controlSchema, emptyProfile, fieldsSchema, type Actor, type Conversation, type Job } from './contracts';
import { stopReason, cleanIncoming, isAutomaticMail, humanRequest, optedOut, commitmentRequest, intakeQuestion, mergeFields, followupDates, supportedEvidence } from './policy';

@Injectable()
export class InboxAutomation implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?:NodeJS.Timeout; private busy=new Set<string>(); private lastMaintenance=0; private lastReception=0;
  constructor(readonly store:InboxRepository, readonly cw:Chatwoot, readonly okki:OkkiWriter, readonly exports:InboxExports) {}
  async routeReception(c:Conversation,db:any):Promise<Conversation> {
    if(!config().officeReception||!(c as any).reception_managed||c.blocked||c.opted_out||c.mode==='paused'||c.native_status==='resolved')return c;
    const route=await this.cw.reception(c.conversation_id);
    const mode=route.mode==='human'?'human':(c as any).reception_hold||!config().modelReady?'human_pending':'ai';
    await db.query('UPDATE inbox_v2_conversations SET reception_checked_at=now() WHERE account_id=$1 AND conversation_id=$2',[c.account_id,c.conversation_id]);
    if(mode!==c.mode) {
      await db.query('UPDATE inbox_v2_conversations SET mode=$3,revision=revision+1 WHERE account_id=$1 AND conversation_id=$2',[c.account_id,c.conversation_id,mode]);
      await this.store.cancel(c.group_key,'reception_changed',db,c.conversation_id);
      await this.store.audit('system','reception.routed',String(c.conversation_id),{mode,assigneeId:route.assigneeId,onlineCount:route.onlineCount},db);
    }
    return (await this.store.conversation(c.conversation_id,db))!;
  }
  async reconcileReception() {
    if(!config().officeReception||Date.now()-this.lastReception<5000)return;
    this.lastReception=Date.now();
    const rows=(await this.store.db.query("SELECT conversation_id,group_key FROM inbox_v2_conversations v JOIN inbox_v2_contacts c USING(account_id,contact_id) WHERE v.account_id=$1 AND reception_managed AND mode<>'paused' AND native_status<>'resolved' AND NOT blocked AND NOT opted_out ORDER BY reception_checked_at ASC NULLS FIRST LIMIT 50",[config().accountId])).rows;
    for(const row of rows)await this.store.transaction('group:'+row.group_key,async db=>{
      let c=await this.store.conversation(row.conversation_id,db);if(!c)return;
      c=await this.routeReception(c,db);
      if(stopReason(c))return;
      const last=(await this.cw.messages(c.conversation_id)).filter(m=>!m.private&&[0,1,'incoming','outgoing'].includes(m.message_type)).at(-1);
      if(!last||![0,'incoming'].includes(last.message_type))return;
      const text=await this.receptionInput(c,last,db);
      if(text)await this.store.job('ai',`reception:${c.conversation_id}:${last.id}:${c.revision}`,c.conversation_id,c.group_key,c.revision,{messageId:last.id,text},new Date(),db);
    });
  }
  async receptionInput(c:Conversation,message:any,db:any):Promise<string|null> {
    const epoch=typeof message.created_at==='number'?message.created_at*1000:Date.parse(message.created_at||'');
    const text=cleanIncoming(String(message.content||''));
    if(!Number.isFinite(epoch)||epoch<Date.parse(config().effectiveFrom)||!text||humanRequest(text)||optedOut(text))return null;
    // Reconciliation must retain the same mail-loop and rate guards as ingress.
    if(c.channel==='email'&&(isAutomaticMail(message,text)||await this.automaticEmail(message,c.conversation_id)))return null;
    const recent=await db.query("SELECT count(*)::int n FROM inbox_v2_events WHERE account_id=$1 AND conversation_id=$2 AND kind='message_created' AND created_at>now()-interval '1 minute'",[c.account_id,c.conversation_id]);
    return recent.rows[0].n>20?null:text;
  }
  async linkIdentity(actor:Actor,input:any){
    const b=z.object({conversationId:z.number().int().positive(),otherConversationId:z.number().int().positive(),expectedRevision:z.number().int().min(0),otherExpectedRevision:z.number().int().min(0),confirmed:z.literal(true),reason:z.string().min(8).max(500),evidenceRefs:z.array(z.string().min(4).max(200)).min(1).max(10),requestId:z.uuid()}).parse(input);
    await this.cw.allowed(actor,b.conversationId);await this.cw.allowed(actor,b.otherConversationId);
    return this.store.transaction('intake:'+actor.accountId,async db=>{
      const left=await this.store.conversation(b.conversationId,db),right=await this.store.conversation(b.otherConversationId,db);if(!left||!right)throw new ConflictException('Persisted conversations required');
      // Replay is safe only for the same reviewed request, never for a new stale edit.
      const prior=(await db.query("SELECT detail FROM inbox_v2_audit WHERE account_id=$1 AND action='identity.linked' AND detail->>'requestId'=$2",[actor.accountId,b.requestId])).rows[0];
      const requestHash=createHash('sha256').update(JSON.stringify(b)).digest('hex');
      if(prior){if(prior.detail.requestHash!==requestHash)throw new ConflictException('Identity request changed');return {ok:true,duplicate:true};}
      if(left.revision!==b.expectedRevision||right.revision!==b.otherExpectedRevision)throw new ConflictException('Conversation changed; review both identities again');
      for(const group of [...new Set([left.group_key,right.group_key])].sort())await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['inbox-v2:group:'+group]);
      const lockedLeft=await this.store.conversation(b.conversationId,db),lockedRight=await this.store.conversation(b.otherConversationId,db);
      if(lockedLeft?.revision!==b.expectedRevision||lockedRight?.revision!==b.otherExpectedRevision)throw new ConflictException('Conversation changed during identity review');
      if(left.group_key===right.group_key)return {ok:true,alreadyLinked:true};
      const links=(await db.query('SELECT * FROM inbox_v2_links WHERE account_id=$1 AND group_key=ANY($2)',[actor.accountId,[left.group_key,right.group_key]])).rows;
      if(links.length>1)throw new ConflictException('Both identities have CRM records; resolve those records before linking');
      await this.store.cancel(left.group_key,'identity_linked',db);await this.store.cancel(right.group_key,'identity_linked',db);
      const restriction=(await db.query('SELECT bool_or(blocked) AS blocked,bool_or(opted_out) AS opted_out FROM inbox_v2_contacts WHERE account_id=$1 AND group_key=ANY($2)',[actor.accountId,[left.group_key,right.group_key]])).rows[0];
      await db.query('UPDATE inbox_v2_contacts SET group_key=$3,blocked=$4,opted_out=$5,identity_conflict=false WHERE account_id=$1 AND group_key=ANY($2)',[actor.accountId,[left.group_key,right.group_key],left.group_key,restriction.blocked,restriction.opted_out]);
      await db.query('UPDATE inbox_v2_links SET group_key=$3 WHERE account_id=$1 AND group_key=$2',[actor.accountId,right.group_key,left.group_key]);
      await db.query("UPDATE inbox_v2_conversations SET mode='human',revision=revision+1 WHERE account_id=$1 AND contact_id IN(SELECT contact_id FROM inbox_v2_contacts WHERE account_id=$1 AND group_key=$2)",[actor.accountId,left.group_key]);
      await this.store.audit(String(actor.userId),'identity.linked',String(b.conversationId),{...b,requestHash},db);return {ok:true};
    });
  }
  async ingest(body:any) {
    const cfg=config(),event=String(body.event||''),native=body.conversation || (event.startsWith('conversation_')?body:null);
    if(Number(body.account?.id ?? native?.account_id ?? body.account_id)!==cfg.accountId)return {accepted:false};
    if(event==='contact_updated') {
      const contactId=Number(body.id);
      const known=(await this.store.db.query('SELECT group_key,blocked FROM inbox_v2_contacts WHERE account_id=$1 AND contact_id=$2',[cfg.accountId,contactId])).rows[0];
      if(known && typeof body.blocked==='boolean' && known.blocked!==body.blocked)await this.setGroupBlock(known.group_key,body.blocked,'chatwoot');
      return {accepted:true};
    }
    const cid=Number(native?.id),inboxId=Number(native?.inbox_id ?? body.inbox?.id);
    let channel=cfg.channels[String(inboxId)],personal=false;
    if(!Number.isSafeInteger(cid)||cid<=0||!Number.isSafeInteger(inboxId)||inboxId<=0||cfg.excluded.includes(cid))return {accepted:false};
    if(!['message_created','message_updated','conversation_created','conversation_updated','conversation_status_changed'].includes(event))return {accepted:false};
    if(!channel){
      // Newly bound seat channels reuse CRM intake, with a human owner by default.
      // Trust only the authenticated native inbox, never webhook-supplied metadata.
      const inbox:any=await this.cw.account('/inboxes/'+inboxId);
      personal=Number(inbox.auto_assignment_config?.ake_owner_id)>0 && inbox.auto_assignment_config?.ake_admin_owned!==true;
      if(!personal)return {accepted:false};
      if(inbox.channel_type==='Channel::Email')channel='email';
      else if(inbox.channel_type==='Channel::Api'&&/^ake-seat-\d+$/.test(inbox.additional_attributes?.ake_instance||''))channel='whatsapp';
      else return {accepted:false};
    }
    const current:any=await this.cw.account('/conversations/'+cid);
    if(current.inbox_id!==inboxId)throw new Error('inbox_scope_mismatch');
    const contact=current.meta?.sender;
    if(!contact?.id)throw new Error('missing_contact');
    const epoch=typeof body.created_at==='number'?body.created_at*1000:Date.parse(body.created_at||native?.created_at||'');
    const occurred=Number.isFinite(epoch)?new Date(epoch):new Date();
    const messageId=Number(body.id),incoming=event==='message_created'&&[0,'incoming'].includes(body.message_type)&&body.private!==true;
    const outgoing=event==='message_created'&&[1,'outgoing'].includes(body.message_type)&&body.private!==true;
    const text=cleanIncoming(String(body.content||''));
    const eventKey=event+':'+(event.startsWith('message')?messageId:cid)+(event==='message_created'?'':':'+createHash('sha256').update(JSON.stringify(body)).digest('hex'));
    if(await this.store.db.query('SELECT 1 FROM inbox_v2_events WHERE account_id=$1 AND event_key=$2',[cfg.accountId,eventKey]).then(r=>r.rowCount))return {accepted:true,duplicate:true};
    const verified=(await this.store.db.query('SELECT identity_verified FROM inbox_v2_contacts WHERE account_id=$1 AND contact_id=$2',[cfg.accountId,contact.id])).rows[0]?.identity_verified===true;
    const email=String(contact.email||'').trim().toLowerCase(),phone=String(contact.phone_number||'').trim();
    // A channel proves its own address, not optional contact profile fields.
    const emailHash=(channel==='email'||verified)&&email?this.store.identity('email:'+email):null,phoneHash=(channel==='whatsapp'||verified)&&/^\+[1-9]\d{6,14}$/.test(phone)?this.store.identity('phone:'+phone):null;
    return this.store.transaction('intake:'+cfg.accountId,async db=>{
      const envelope={...body,akeInboxContext:{accountId:cfg.accountId,inboxId,conversationId:cid,messageId:event.startsWith('message')?messageId:null,channel,sourceTime:occurred.toISOString(),isTest:cfg.testContacts.includes(Number(contact.id))}};
      const duplicate=await db.query(`INSERT INTO inbox_v2_events(account_id,event_key,conversation_id,kind,payload,occurred_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING event_key`,[cfg.accountId,eventKey,cid,event,this.store.pack(envelope),occurred]);
      if(!duplicate.rowCount)return {accepted:true,duplicate:true};
      const oldContact=(await db.query('SELECT * FROM inbox_v2_contacts WHERE account_id=$1 AND contact_id=$2',[cfg.accountId,contact.id])).rows[0];
      const matches=await db.query(`SELECT DISTINCT c.group_key FROM inbox_v2_contacts c WHERE c.account_id=$1 AND (
        (c.email_hash=$2 AND (c.identity_verified OR EXISTS(SELECT 1 FROM inbox_v2_conversations v WHERE v.account_id=c.account_id AND v.contact_id=c.contact_id AND v.channel='email'))) OR
        (c.phone_hash=$3 AND (c.identity_verified OR EXISTS(SELECT 1 FROM inbox_v2_conversations v WHERE v.account_id=c.account_id AND v.contact_id=c.contact_id AND v.channel='whatsapp'))))`,[cfg.accountId,emailHash,phoneHash]);
      const groups=new Set(matches.rows.map(r=>r.group_key)); if(oldContact)groups.add(oldContact.group_key);
      const group=groups.size===1?[...groups][0]:oldContact?.group_key||'contact:'+contact.id;
      if(groups.size>1)await this.store.audit('system','identity.review',String(cid),{reason:'conflicting_exact_identities'},db);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['inbox-v2:group:'+group]);
      const groupState=(await db.query('SELECT bool_or(blocked) AS blocked,bool_or(opted_out) AS opted_out FROM inbox_v2_contacts WHERE account_id=$1 AND group_key=$2',[cfg.accountId,group])).rows[0];
      // Native widget custom attributes can be supplied by visitors. Only the
      // authenticated profile review endpoint confirms a follow-up timezone.
      const timezone=null;
      await db.query(`INSERT INTO inbox_v2_contacts(account_id,contact_id,group_key,email_hash,phone_hash,blocked,opted_out,timezone,profile) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(account_id,contact_id) DO UPDATE SET email_hash=COALESCE(excluded.email_hash,inbox_v2_contacts.email_hash),phone_hash=COALESCE(excluded.phone_hash,inbox_v2_contacts.phone_hash),profile=excluded.profile,timezone=COALESCE(excluded.timezone,inbox_v2_contacts.timezone),blocked=inbox_v2_contacts.blocked OR excluded.blocked,updated_at=now()`,
      [cfg.accountId,contact.id,group,emailHash,phoneHash,Boolean(contact.blocked||groupState.blocked),Boolean(groupState.opted_out),timezone,this.store.pack(contact)]);
      if(groups.size>1)await db.query('UPDATE inbox_v2_contacts SET identity_conflict=true WHERE account_id=$1 AND contact_id=$2',[cfg.accountId,contact.id]);
      await db.query(`INSERT INTO inbox_v2_conversations(account_id,conversation_id,contact_id,inbox_id,channel,profile,native_status,mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(account_id,conversation_id) DO UPDATE SET native_status=excluded.native_status,updated_at=now()`,[cfg.accountId,cid,contact.id,inboxId,channel,this.store.pack(emptyProfile()),current.status||'open',personal?'human':'ai']);
      let conv=(await this.store.conversation(cid,db))!;
      if(event==='message_updated'&&[1,'outgoing'].includes(body.message_type)&&body.content_attributes?.ake_inbox_job){
        const reference=String(body.content_attributes.ake_inbox_job),status=String(body.status||'');
        const sent=(await db.query("SELECT * FROM inbox_v2_jobs WHERE id=$1 AND account_id=$2 AND conversation_id=$3 AND kind IN ('send','followup')",[reference,cfg.accountId,cid])).rows[0];
        if(sent&&['sent','delivered','read','failed'].includes(status)){
          await db.query("UPDATE inbox_v2_jobs SET result=COALESCE(result,'{}'::jsonb)||$2::jsonb WHERE id=$1",[reference,JSON.stringify({nativeStatus:status,messageId})]);
          if(status==='failed'){
            await db.query("UPDATE inbox_v2_jobs SET state='review',error='native_delivery_failed' WHERE id=$1 AND state IN ('processing','sent','accepted')",[reference]);
            await db.query("UPDATE inbox_v2_jobs SET state='cancelled',error='question_not_delivered' WHERE account_id=$1 AND (id LIKE $2 OR id=$3) AND kind IN ('followup','reminder') AND state IN ('pending','processing')",[cfg.accountId,'followup:'+reference+':%','timezone:'+reference]);
            await db.query("UPDATE inbox_v2_conversations SET mode='human_pending',revision=revision+1 WHERE account_id=$1 AND conversation_id=$2 AND revision=$3 AND mode='ai'",[cfg.accountId,cid,sent.revision]);
            await this.store.audit('system','delivery.failed',String(cid),{messageId,jobId:reference},db);
          }
        }
      }
      const botJob=body.content_attributes?.ake_inbox_job?(await db.query("SELECT 1 FROM inbox_v2_jobs WHERE id=$1 AND account_id=$2 AND conversation_id=$3 AND kind IN ('send','followup')",[String(body.content_attributes.ake_inbox_job),cfg.accountId,cid])).rowCount:0;
      if(outgoing && !botJob) {
        await db.query("UPDATE inbox_v2_conversations SET mode='human',revision=revision+1 WHERE account_id=$1 AND conversation_id=$2",[cfg.accountId,cid]);
        await this.store.cancel(group,'human_reply',db,cid);
      }
      if(current.status==='resolved') {
        await db.query("UPDATE inbox_v2_conversations SET mode='paused',revision=revision+1 WHERE account_id=$1 AND conversation_id=$2",[cfg.accountId,cid]);
        await this.store.cancel(group,'closed',db,cid);
      }
      if(!incoming)return {accepted:true};
      await db.query('UPDATE inbox_v2_conversations SET revision=revision+1,last_inbound_at=$3 WHERE account_id=$1 AND conversation_id=$2',[cfg.accountId,cid,occurred]);
      // A reply on any linked channel cancels the old contact follow-up plan.
      await db.query("UPDATE inbox_v2_jobs SET state='cancelled',error='customer_replied' WHERE account_id=$1 AND group_key=$2 AND kind IN ('followup','reminder') AND state IN ('pending','processing')",[cfg.accountId,group]);
      conv=(await this.store.conversation(cid,db))!;
      // Offline form submissions are a human callback queue, not a live AI chat.
      // Read the server-created native attribute, not a visitor's custom fields.
      if(current.additional_attributes?.ake_offline_submission===true) {
        await db.query("UPDATE inbox_v2_conversations SET mode='human_pending',reception_hold=true WHERE account_id=$1 AND conversation_id=$2",[cfg.accountId,cid]);
        await this.store.cancel(group,'offline_callback',db,cid);
        return {accepted:true,mode:'human_pending',offlineCallback:true};
      }
      if(optedOut(text)) {
        await db.query('UPDATE inbox_v2_contacts SET opted_out=true WHERE account_id=$1 AND group_key=$2',[cfg.accountId,group]);
        await this.store.cancel(group,'opted_out',db);return {accepted:true,mode:'opted_out'};
      }
      if(humanRequest(text)) {
        await db.query("UPDATE inbox_v2_conversations SET mode='human_pending',reception_hold=true WHERE account_id=$1 AND conversation_id=$2",[cfg.accountId,cid]);
        await this.store.cancel(group,'human_requested',db,cid);
      }
      if(occurred.getTime()<Date.parse(cfg.effectiveFrom))return {accepted:true,historical:true};
      if(channel==='email' && (isAutomaticMail(body,text)||await this.automaticEmail(body,cid)))return {accepted:true,automaticMail:true};
      const recent=await db.query("SELECT count(*)::int n FROM inbox_v2_events WHERE account_id=$1 AND conversation_id=$2 AND kind='message_created' AND created_at>now()-interval '1 minute'",[cfg.accountId,cid]);
      if(recent.rows[0].n>20){await this.store.audit('system','rate_limited',String(cid),{},db);return {accepted:true,rateLimited:true};}
      // Closing a managed conversation pauses its old jobs, but a new customer
      // message can reopen it in the native inbox. Explicit human pauses use
      // reception_hold and must never be cleared by this automatic transition.
      if(cfg.officeReception&&(conv as any).reception_managed&&conv.mode==='paused'&&!(conv as any).reception_hold&&
        current.status==='open'&&!conv.blocked&&!conv.opted_out) {
        await db.query("UPDATE inbox_v2_conversations SET mode='human_pending',revision=revision+1 WHERE account_id=$1 AND conversation_id=$2",[cfg.accountId,cid]);
        await this.store.audit('system','reception.reopened',String(cid),{messageId},db);
      }
      if(cfg.officeReception){
        await db.query('UPDATE inbox_v2_conversations SET reception_managed=true WHERE account_id=$1 AND conversation_id=$2',[cfg.accountId,cid]);
        conv=await this.routeReception((await this.store.conversation(cid,db))!,db);
      }
      const validInquiry=/parking|anpr|lpr|rfid|barrier|project|integrat|停车|项目|车牌|道闸|车位|系统/i.test(text)||Boolean(this.store.unpack(conv.profile)?.fields?.products?.length);
      if(validInquiry&&!conv.blocked&&!conv.opted_out)await this.store.job('okki','okki:'+cid+':'+messageId,cid,group,conv.revision,{messageId,text},new Date(),db);
      if(!stopReason(conv)&&!humanRequest(text)&&text)await this.store.job('ai',cfg.officeReception?`reception:${cid}:${messageId}:${conv.revision}`:'ai:'+cid+':'+messageId,cid,group,conv.revision,{messageId,text},new Date(),db);
      return {accepted:true,durable:true};
    });
  }
  async automaticEmail(body:any,cid:number) {
    let source=body.source_id;
    if(!source)source=(await this.cw.messages(cid)).find(m=>Number(m.id)===Number(body.id))?.source_id;
    if(!source||!config().archiveRoot)return false;
    const key=createHash('sha256').update(String(source).replace(/^<|>$/g,'')).digest('hex');
    const dir=join(config().archiveRoot,'email_ids',key);
    for(const name of await readdir(dir).catch(()=>[] as string[])){
      if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
      const meta=JSON.parse(await readFile(join(dir,name),'utf8'));
      if(meta.account_id===config().accountId&&isAutomaticMail({content_attributes:{headers:meta.headers}},''))return true;
    }
    return false;
  }
  async setGroupBlock(group:string,blocked:boolean,actor:string) {
    return this.store.transaction('group:'+group,async db=>{
      await db.query('UPDATE inbox_v2_contacts SET blocked=$3 WHERE account_id=$1 AND group_key=$2',[config().accountId,group,blocked]);
      await db.query(`UPDATE inbox_v2_conversations SET mode='human',revision=revision+1 WHERE account_id=$1 AND contact_id IN(SELECT contact_id FROM inbox_v2_contacts WHERE account_id=$1 AND group_key=$2)`,[config().accountId,group]);
      await this.store.cancel(group,blocked?'blocked':'unblocked_without_replay',db);
      await this.store.audit(actor,blocked?'contact.block':'contact.unblock',group,{},db);
    });
  }
  async control(cid:number,input:unknown,actor:Actor) {
    const command=controlSchema.parse(input); await this.cw.allowed(actor,cid);
    const c=await this.store.conversation(cid);if(!c)throw new BadRequestException('Conversation has not been indexed');
    if(command.action==='resume'&&!config().channels[String(c.inbox_id)])throw new ConflictException('此个人渠道由坐席接待；启用自动接待前需配置渠道发送控制。');
    const key='control:'+actor.userId+':'+command.idempotencyKey;
    const result=await this.store.actionOnce(key,createHash('sha256').update(JSON.stringify({cid,command})).digest('hex'),async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['inbox-v2:group:'+c.group_key]);
      const latest=(await this.store.conversation(cid,db))!;
      if(latest.revision!==command.expectedRevision)throw new ConflictException('Conversation changed. Refresh before continuing.');
      if(command.action==='resume'&&(latest.blocked||latest.opted_out))throw new ConflictException('Blocked or opted-out contacts cannot resume automatically');
      const mode=command.action==='resume'?'ai':command.action==='pause'?'paused':['cancel_followups','verify_identity'].includes(command.action)?latest.mode:'human';
      await db.query('UPDATE inbox_v2_conversations SET mode=$3,revision=revision+1 WHERE account_id=$1 AND conversation_id=$2',[config().accountId,cid,mode]);
      if(['resume','pause'].includes(command.action))await db.query('UPDATE inbox_v2_conversations SET reception_hold=$3 WHERE account_id=$1 AND conversation_id=$2',[config().accountId,cid,command.action==='pause']);
      if(command.action==='verify_identity')await db.query('UPDATE inbox_v2_contacts SET identity_verified=true WHERE account_id=$1 AND contact_id=$2',[config().accountId,latest.contact_id]);
      if(['block','unblock','unsubscribe'].includes(command.action)) {
        const column=command.action==='unsubscribe'?'opted_out':'blocked';
        await db.query(`UPDATE inbox_v2_contacts SET ${column}=$3 WHERE account_id=$1 AND group_key=$2`,[config().accountId,c.group_key,command.action!=='unblock']);
        await db.query(`UPDATE inbox_v2_conversations SET mode='human',revision=revision+1 WHERE account_id=$1 AND conversation_id<>$3 AND contact_id IN(SELECT contact_id FROM inbox_v2_contacts WHERE account_id=$1 AND group_key=$2)`,[config().accountId,c.group_key,cid]);
      }
      await db.query("UPDATE inbox_v2_jobs SET state='cancelled',error=$3 WHERE account_id=$1 AND group_key=$2 AND kind IN ('followup','reminder') AND state IN ('pending','processing')",[config().accountId,c.group_key,command.action]);
      if(command.action!=='cancel_followups')await this.store.cancel(c.group_key,command.action,db,['block','unblock','unsubscribe'].includes(command.action)?undefined:cid);
      await this.store.audit(String(actor.userId),command.action,String(cid),{reason:command.reason},db);
      return {ok:true,revision:latest.revision+1,mode};
    });
    if(['block','unblock'].includes(command.action)){
      const ids=(await this.store.db.query('SELECT contact_id FROM inbox_v2_contacts WHERE account_id=$1 AND group_key=$2',[config().accountId,c.group_key])).rows;
      for(const row of ids)await this.cw.account('/contacts/'+row.contact_id,{blocked:command.action==='block'},'PUT');
    }
    return result;
  }
  async admission(cid:number,jobId?:string,revision?:number) {
    const c=await this.store.conversation(cid);
    if(!c){if(jobId)return {allowed:false,reason:'unindexed'};const native=await this.cw.account('/conversations/'+cid);return {allowed:!native.meta?.sender?.blocked&&!!config().channels[String(native.inbox_id)]};}
    if(c.blocked||c.opted_out)return {allowed:false,reason:c.blocked?'blocked':'opted_out'};
    if(!jobId)return {allowed:true}; // Native human replies use the human-reply hook, not the AI mode gate.
    if(config().officeReception&&(!config().modelReady||(await this.cw.reception(cid,true)).onlineCount>0))return {allowed:false,reason:'reception_not_ai'};
    const job=(await this.store.db.query('SELECT * FROM inbox_v2_jobs WHERE id=$1 AND account_id=$2 AND conversation_id=$3',[jobId,config().accountId,cid])).rows[0];
    return {allowed:config().autoSend&&config().autoChannels.includes(c.channel)&&(!config().testContacts.length||config().testContacts.includes(Number(c.contact_id)))&&!stopReason(c)&&c.revision===revision&&!!job&&['processing','sent','accepted'].includes(job.state),reason:stopReason(c)||null};
  }
  async nativeHuman(cid:number) {
    const c=await this.store.conversation(cid);if(!c)return {ok:true};
    await this.store.transaction('group:'+c.group_key,async db=>{
      await db.query("UPDATE inbox_v2_conversations SET mode='human',revision=revision+1 WHERE account_id=$1 AND conversation_id=$2",[config().accountId,cid]);
      await this.store.cancel(c.group_key,'human_reply',db,cid);
      await db.query("UPDATE inbox_v2_jobs SET state='cancelled',error='human_reply' WHERE account_id=$1 AND group_key=$2 AND kind IN ('followup','reminder') AND state IN ('pending','processing')",[config().accountId,c.group_key]);
    });return {ok:true};
  }
  async retrieve(text:string) {
    const rows=(await this.store.db.query("SELECT DISTINCT ON(id) * FROM inbox_v2_knowledge WHERE state='approved' ORDER BY id,version DESC")).rows;
    const words:string[]=Array.from(text.toLowerCase().match(/[a-z0-9]{2,}/g)||[]);
    for(const segment of text.match(/[\u4e00-\u9fff]+/g)||[])for(let i=0;i<segment.length-1;i++)words.push(segment.slice(i,i+2));
    return rows.map(row=>({row,score:[...words,...(text.match(/[\u4e00-\u9fff]{2,}/g)||[])].reduce((n,w)=>n+(String(row.title+' '+row.body+' '+JSON.stringify(row.tags)).toLowerCase().includes(w)?1:0),0)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,3).map(x=>x.row);
  }
  async analyze(job:Job) {
    const c=await this.store.conversation(job.conversation_id);if(!c||stopReason(c)||c.revision!==job.revision)return this.store.finish(job.id,'cancelled');
    const input=this.store.unpack(job.payload),profile=this.store.unpack(c.profile)||emptyProfile();
    const messages=(await this.cw.messages(c.conversation_id)).filter(m=>!m.private&&[0,1,'incoming','outgoing'].includes(m.message_type)).slice(-16).map(m=>({id:m.id,role:[0,'incoming'].includes(m.message_type)?'customer':'assistant',text:cleanIncoming(String(m.content||''))}));
    const knowledge=await this.retrieve(input.text);
    if(commitmentRequest(input.text))return this.handoff(job,'commercial_confirmation');
    if(!knowledge.length && /\?|？/.test(input.text) && !intakeQuestion(input.text))return this.handoff(job,'knowledge_not_covered');
    const response=await fetch(config().modelUrl+'/generate',{method:'POST',signal:AbortSignal.timeout(80000),headers:{'content-type':'application/json','x-inbox-key':config().internalKey},body:JSON.stringify({messages,profile,knowledge:knowledge.map(k=>({id:k.id,version:k.version,title:k.title,body:k.body,conditions:k.tags.conditions})),maxQuestions:2})});
    if(!response.ok)throw new Error('model_unavailable');const d:any=await response.json();
    if(d.mode!=='api'||typeof d.reply!=='string'||d.reply.length>2000||(d.reply.match(/[?？]/g)||[]).length>2)throw new Error('invalid_model_response');
    if((d.askedFields||[]).some((key:string)=>profile.fields[key]!==null&&profile.fields[key]!==undefined&&(!Array.isArray(profile.fields[key])||profile.fields[key].length)))throw new Error('repeated_known_question');
    const fields=fieldsSchema.parse(d.fields),review:any[]=[],source=messages.filter(m=>m.role==='customer').map(m=>m.text).join('\n');
    const evidence=Array.isArray(d.evidence)?d.evidence:[];
    for(const [key,value] of Object.entries(fields)) {
      if(value===null||(Array.isArray(value)&&!value.length))continue;
      if((profile.confirmed||[]).includes(key)&&JSON.stringify(profile.fields[key])!==JSON.stringify(value))review.push({field:key,value,reason:'human_field_conflict'});
      if(evidence.some((e:any)=>e.field===key&&e.kind==='inferred'))review.push({field:key,value,reason:'inferred_not_applied'});
      if(!evidence.some((e:any)=>e.field===key&&e.kind==='stated'&&typeof e.quote==='string'&&e.quote.length>0&&source.includes(e.quote)&&supportedEvidence(value,e.quote))) (fields as any)[key]=Array.isArray(value)?[]:null;
    }
    if(/-----BEGIN|Bearer\s|sk-[a-zA-Z0-9]{12}|access_token|refresh_token/i.test(d.reply))throw new Error('model_output_rejected');
    const cited=Array.isArray(d.knowledgeIds)?d.knowledgeIds:[];
    if((d.hasProductClaims===true&&!cited.length)||cited.some((id:string)=>!knowledge.some(k=>k.id===id)))throw new Error('knowledge_citation_invalid');
    await this.store.transaction('group:'+c.group_key,async db=>{
      const current=(await this.store.conversation(c.conversation_id,db))!;
      if(stopReason(current)||current.revision!==job.revision)return this.store.finish(job.id,'cancelled',{},null,db);
      const next={...profile,review:[...(profile.review||[]),...review].slice(-30),fields:mergeFields(profile.fields,fields,profile.confirmed||[]),evidence,asked:[...(profile.asked||[]),...(Array.isArray(d.askedFields)?d.askedFields:[])]};
      await db.query('UPDATE inbox_v2_conversations SET profile=$3,summary=$4 WHERE account_id=$1 AND conversation_id=$2',[config().accountId,c.conversation_id,this.store.pack(next),this.store.pack({text:String(d.summary||'').slice(0,1200),knowledge:cited})]);
      if(d.needsHuman)return;
      await this.store.job('send','reply:'+job.id,c.conversation_id,c.group_key,current.revision,{text:d.reply,question:(d.reply.match(/[?？]/g)||[]).length>0,knowledge:cited},new Date(),db);
      if(/parking|anpr|lpr|rfid|barrier|project|integrat|停车|项目|车牌|道闸|车位|系统/i.test(input.text)||next.fields.products.length||next.fields.projectType)
        await this.store.job('okki','analysis:'+job.id,c.conversation_id,c.group_key,current.revision,{messageId:input.messageId,text:String(d.summary||'')},new Date(),db);
    });
    if(d.needsHuman)return this.handoff(job,'model_requested_human');
    await this.store.finish(job.id,'done',{mode:'api',knowledgeIds:cited});
  }
  async handoff(job:Job,reason:string) {
    await this.store.db.query("UPDATE inbox_v2_conversations SET mode='human_pending',reception_hold=true,revision=revision+1 WHERE account_id=$1 AND conversation_id=$2 AND revision=$3",[config().accountId,job.conversation_id,job.revision]);
    await this.store.finish(job.id,'review',{},reason);
    await this.cw.account('/conversations/'+job.conversation_id+'/toggle_status',{status:'open'}).catch(()=>undefined);
  }
  async send(job:Job) {
    return this.store.transaction('group:'+job.group_key,async db=>{
      const currentJob=(await db.query('SELECT state FROM inbox_v2_jobs WHERE id=$1',[job.id])).rows[0];
      if(currentJob?.state!=='processing')return;
      const c=await this.store.conversation(job.conversation_id,db);
      if(!config().autoSend||!c||!config().autoChannels.includes(c.channel)||(config().testContacts.length&&!config().testContacts.includes(Number(c.contact_id)))||stopReason(c)||c.revision!==job.revision)return this.store.finish(job.id,'cancelled',{},null,db);
      const native:any=await this.cw.account('/conversations/'+c.conversation_id);
      if(native.meta?.sender?.blocked||native.status==='resolved')return this.store.finish(job.id,'cancelled',{},null,db);
      if(config().officeReception&&(!config().modelReady||(await this.cw.reception(c.conversation_id)).onlineCount>0))return this.store.finish(job.id,'cancelled',{},'reception_changed',db);
      const payload=this.store.unpack(job.payload);
      if(job.kind==='followup' && (c.followup_count>=2 || Date.now()-new Date((job as any).due_at||Date.now()).getTime()>6*3600000))return this.store.finish(job.id,'cancelled',{},'followup_expired',db);
      if(job.kind==='followup') {
        const now=new Date(),work=followupDates(new Date(now.getTime()-24*3600000),c.timezone)[0];
        if(!work)return this.store.finish(job.id,'review',{},'timezone_required',db);
        if(work.getTime()>now.getTime()+60000){await db.query("UPDATE inbox_v2_jobs SET state='pending',due_at=$2 WHERE id=$1",[job.id,work]);return;}
      }
      try {
        const messageId=await this.cw.send(c.conversation_id,payload.text,job.id,c.revision);
        await db.query("UPDATE inbox_v2_jobs SET state='sent',result=$2 WHERE id=$1",[job.id,{messageId}]);
        if(job.kind==='followup')await db.query('UPDATE inbox_v2_conversations SET followup_count=followup_count+1 WHERE account_id=$1 AND conversation_id=$2',[config().accountId,c.conversation_id]);
        if(job.kind==='send'&&payload.question&&c.followup_count<2) {
          await db.query("UPDATE inbox_v2_jobs SET state='cancelled',error='new_plan' WHERE account_id=$1 AND group_key=$2 AND kind='followup' AND state IN ('pending','processing')",[config().accountId,c.group_key]);
          const dates=followupDates(new Date(),c.timezone);
          if(!dates.length){await this.store.job('reminder','timezone:'+job.id,c.conversation_id,c.group_key,c.revision,{reason:'timezone_required'},new Date(),db);await this.store.audit('system','followup.timezone_required',String(c.conversation_id),{},db);}
          for(let n=0;n<Math.min(dates.length,2-c.followup_count);n++) await this.store.job('followup','followup:'+job.id+':'+n,c.conversation_id,c.group_key,c.revision,{text:/[\u4e00-\u9fff]/.test(payload.text)?'想跟进一下您的项目需求。您方便时可以补充项目地点、所需产品和预计预算；如需人工协助或停止提醒，请直接告诉我们。':'Following up on your parking project. When convenient, please share the project location, required products and estimated budget. You can ask for a person or reply STOP to end reminders.'},dates[n],db);
        }
      }catch {await this.store.finish(job.id,'review',{},'delivery_uncertain',db);}
    });
  }
  async sync(job:Job) {
    const c=await this.store.conversation(job.conversation_id);if(!c)return this.store.finish(job.id,'cancelled');
    if(c.blocked||c.opted_out)return this.store.finish(job.id,'cancelled');
    if((await this.store.db.query('SELECT identity_conflict FROM inbox_v2_contacts WHERE account_id=$1 AND contact_id=$2',[config().accountId,c.contact_id])).rows[0]?.identity_conflict)return this.store.finish(job.id,'review',{},'identity_conflict');
    if(!config().autoChannels.includes(c.channel)||(config().testContacts.length&&!config().testContacts.includes(Number(c.contact_id))))return this.store.finish(job.id,'review',{},'channel_not_enabled');
    if(!config().okkiWrite)return this.store.finish(job.id,'review',{},'okki_write_disabled');
    const contact=this.store.unpack(c.contact_profile),verified=(await this.store.db.query('SELECT identity_verified FROM inbox_v2_contacts WHERE account_id=$1 AND contact_id=$2',[config().accountId,c.contact_id])).rows[0]?.identity_verified===true;
    contact.identityConfirmed=c.channel!=='website'||verified;
    if(!verified&&c.channel==='email')contact.phone_number='';
    if(!verified&&c.channel==='whatsapp')contact.email='';
    const profile=this.store.unpack(c.profile),payload=this.store.unpack(job.payload);
    const link=await this.okki.syncLead(c.group_key,c.conversation_id,contact,profile,c.channel);
    if(payload.text){const trailId=await this.okki.write('activity:'+job.id,'trail','/v1/dynamic/trail/push',{
      ...(link.company_id?{company_id:Number(link.company_id)}:{lead_id:Number(link.lead_id)}),remark_type:101,
      content:`[AKE-INBOX:${config().accountId}:${c.conversation_id}:${payload.messageId}] ${payload.text.slice(0,4000)}`,
    },'trail_id');await this.okki.verifyTrail(trailId,link.company_id?{company_id:link.company_id}:{lead_id:link.lead_id});}
    await this.store.finish(job.id,'done',{leadId:link.lead_id,companyId:link.company_id});
  }
  async tick(lane='effects') {
    if(this.busy.has(lane)||!config().enabled)return;this.busy.add(lane);
    try {
      if(lane==='reception'){await this.reconcileReception();return;}
      if(lane==='maintenance'){
        if(Date.now()-this.lastMaintenance<300000)return;this.lastMaintenance=Date.now();await this.store.recover();await this.exports.cleanup();
        const links=(await this.store.db.query("SELECT group_key FROM inbox_v2_links WHERE account_id=$1 AND (refreshed_at IS NULL OR refreshed_at<now()-interval '5 minutes') LIMIT 50",[config().accountId])).rows;
        for(const link of links){try{await this.okki.refresh(link.group_key);}catch{await this.store.audit('system','okki.refresh_failed',link.group_key);}}
        return;
      }
      const job=await this.store.claim(lane==='model'?['ai']:lane==='crm'?['okki','opportunity']:['send','followup']);if(!job)return;
      try {
        if(job.kind==='ai')await this.analyze(job);
        else if(['send','followup'].includes(job.kind))await this.send(job);
        else if(job.kind==='okki')await this.sync(job);
        else {
          const c=(await this.store.conversation(job.conversation_id))!;
          const result=await this.okki.opportunity(c.group_key,c.conversation_id,this.store.unpack(job.payload),this.store.unpack(c.contact_profile));await this.store.finish(job.id,'done',result);
        }
      }catch(error) {
        const reason=error instanceof UncertainWrite?'write_requires_reconciliation':error instanceof Error?error.message:'processing_failed';
        if(job.kind==='ai'&&job.attempts<2)await this.store.db.query("UPDATE inbox_v2_jobs SET state='pending',due_at=now()+interval '10 seconds',error=$2 WHERE id=$1 AND state='processing'",[job.id,reason]);
        else if(job.kind==='ai')await this.handoff(job,reason);
        else if(job.kind==='okki'&&!(error instanceof UncertainWrite)&&job.attempts<5&&!/conflict|waiting_identity|disabled/.test(reason))await this.store.db.query("UPDATE inbox_v2_jobs SET state='pending',due_at=now()+($2||' seconds')::interval,error=$3 WHERE id=$1",[job.id,Math.min(300,2**job.attempts*5),reason]);
        else await this.store.finish(job.id,'review',{},reason);
      }
    }finally{this.busy.delete(lane);}
  }
  onApplicationBootstrap(){if(config().enabled){this.timer=setInterval(()=>{for(const lane of ['model','crm','effects','maintenance','reception'])void this.tick(lane).catch(()=>undefined);},1000);this.timer.unref();}}
  onModuleDestroy(){if(this.timer)clearInterval(this.timer);}
}
