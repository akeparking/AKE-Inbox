import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { InboxRepository } from '../inbox-v2/repository';
import { Chatwoot } from '../inbox-v2/chatwoot';
import { config, type Actor } from '../inbox-v2/contracts';
import { REVENUE_STORE, type RevenueStore } from '../store/store.types';
import { loadConfig } from '../config';
import { InboxAutomation } from '../inbox-v2/automation.service';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeControl } from './bridge';
import { MetaFeedback } from './meta-feedback';
import { marketingAttribution } from './contracts';
import { consentSchema, sessionSchema, eventSchema, formSchema, submissionSchema, safeUrl, safeTelemetryText, touch, hash, readToken, signToken, shortCode, codeFromMessage, validateFields, type SessionClaims } from './contracts';

@Injectable()
export class MarketingService {
  private timer?:NodeJS.Timeout;
  private busy=false;
  private maintenanceAt=0;
  constructor(private readonly repo:InboxRepository,private readonly cw:Chatwoot,@Inject(REVENUE_STORE) private readonly revenue:RevenueStore,private readonly automation:InboxAutomation){}
  ready(){if(process.env.MARKETING_ENABLED!=='true'||!config().enabled)throw new ServiceUnavailableException('Marketing is disabled');}
  private capture(){this.ready();if(process.env.ATTRIBUTION_CAPTURE_ENABLED!=='true')throw new ServiceUnavailableException('Tracking is disabled');}
  private admin(actor:Actor){if(actor.role!=='administrator')throw new ForbiddenException('Administrator access required');}
  async site(id:string,origin?:string){
    this.ready();const row=(await this.repo.db.query('SELECT * FROM marketing_sites WHERE id=$1 AND account_id=$2 AND enabled=true',[id,config().accountId])).rows[0];
    if(!row)throw new NotFoundException('Registered site unavailable');
    if(origin!==undefined&&origin!==row.origin)throw new ForbiddenException('Site origin mismatch');return row;
  }
  private protectedTouch(page:string,ref:string,consent:any){const t=touch(page,ref,consent);const {identifiers,...publicTouch}=t;return {...publicTouch,identifiersCipher:Object.keys(identifiers).length?this.repo.pack(identifiers):null};}
  private displayTouch(t:any){if(!t)return null;const {identifiersCipher,...rest}=t;return {...rest,hasAdIdentifier:!!identifiersCipher};}
  async session(input:unknown,origin:string){
    this.ready();const b=sessionSchema.parse(input),site=await this.site(b.siteId,origin);
    if(new URL(b.pageUrl).origin!==site.origin)throw new ForbiddenException('Page origin mismatch');
    const prior=readToken(b.visitorToken||''),priorVisit=readToken(b.visitToken||'');
    const visitorId=prior?.kind==='visitor'&&prior.siteId===site.id?prior.visitorId:null;
    return this.repo.transaction('marketing-session:'+(visitorId||randomUUID()),async db=>{
      const consentId=randomUUID();await db.query('INSERT INTO marketing_consents(id,site_id,choices,policy_version) VALUES($1,$2,$3,$4)',[consentId,site.id,b.consent,b.policyVersion]);
      const old=visitorId?(await db.query('SELECT * FROM marketing_visitors WHERE id=$1 AND site_id=$2 FOR UPDATE',[visitorId,site.id])).rows[0]:null;
      if(b.consent.analytics!=='granted'||process.env.ATTRIBUTION_CAPTURE_ENABLED!=='true'){
        if(old&&b.consent.analytics!=='granted')await db.query('UPDATE marketing_visitors SET revoked_at=now(),consent_id=$2 WHERE id=$1',[old.id,consentId]);
        return {sessionToken:signToken({siteId:site.id,visitorId:null,visitId:null,consentId,exp:Date.now()+3600000}),visitorToken:null,visitToken:null,coverage:{analytics:b.consent.analytics,captureEnabled:process.env.ATTRIBUTION_CAPTURE_ENABLED==='true',storageAvailable:b.storageAvailable,history:'not_collected'}};
      }
      let vid=old&&!old.revoked_at?old.id:randomUUID();const t=this.protectedTouch(b.pageUrl,b.referrer,b.consent);
      if(vid===old?.id)await db.query('UPDATE marketing_visitors SET consent_id=$2,last_seen_at=now() WHERE id=$1',[vid,consentId]);
      else await db.query('INSERT INTO marketing_visitors(id,site_id,first_touch,consent_id) VALUES($1,$2,$3,$4)',[vid,site.id,t,consentId]);
      const idle=Number(site.settings.sessionMinutes||30);
      let visit=priorVisit?.siteId===site.id&&priorVisit.visitorId===vid&&priorVisit.visitId?(await db.query("SELECT * FROM marketing_visits WHERE id=$1 AND visitor_id=$2 AND last_seen_at>now()-($3||' minutes')::interval",[priorVisit.visitId,vid,idle])).rows[0]:null;
      if(visit&&Object.keys(t.utm).length&&hash(t.utm)!==hash(visit.current_touch.utm))visit=null;
      const visitId=visit?.id||randomUUID(),coverage={analytics:'granted',storageAvailable:b.storageAvailable,history:old&&!old.revoked_at?'observed':'starts_here',dwell:'visible_time_estimate'};
      if(visit)await db.query('UPDATE marketing_visits SET last_seen_at=now() WHERE id=$1',[visitId]);
      else await db.query('INSERT INTO marketing_visits(id,visitor_id,site_id,current_touch,coverage) VALUES($1,$2,$3,$4,$5)',[visitId,vid,site.id,t,coverage]);
      const claims={siteId:site.id,visitorId:vid,visitId,consentId,exp:Date.now()+86400000};
      return {sessionToken:signToken(claims),visitorToken:signToken({kind:'visitor',siteId:site.id,visitorId:vid,exp:Date.now()+Number(site.settings.retentionDays||90)*86400000}),visitToken:signToken(claims),visitorId:vid,visitId,coverage};
    });
  }
  async claims(token:string,siteId:string):Promise<SessionClaims>{
    const c=readToken(token);if(!c||c.siteId!==siteId||!c.consentId)throw new UnauthorizedException('Invalid website session');
    const receipt=(await this.repo.db.query('SELECT * FROM marketing_consents WHERE id=$1 AND site_id=$2',[c.consentId,siteId])).rows[0];
    if(!receipt)throw new UnauthorizedException('Unknown consent receipt');
    if(c.visitorId){const v=(await this.repo.db.query('SELECT v.*,c.choices FROM marketing_visitors v JOIN marketing_consents c ON c.id=v.consent_id WHERE v.id=$1 AND v.site_id=$2 AND v.revoked_at IS NULL',[c.visitorId,siteId])).rows[0];if(!v||v.choices.analytics!=='granted'||receipt.choices.analytics!=='granted')throw new UnauthorizedException('Consent changed');}
    return c;
  }
  async events(input:unknown,origin:string){
    this.capture();const b=z.object({siteId:z.string(),sessionToken:z.string().max(2000),events:z.array(eventSchema).min(1).max(20)}).parse(input);
    const site=await this.site(b.siteId,origin),c=await this.claims(b.sessionToken,site.id);
    if(!c.visitorId||!c.visitId)return {accepted:[],coverage:'analytics_not_granted'};
    return this.repo.transaction('marketing-events:'+c.visitId,async db=>{
      const accepted=[];
      for(const e of b.events){
        if(new URL(e.pageUrl).origin!==site.origin)throw new ForbiddenException('Page origin mismatch');
        const data={...e,title:safeTelemetryText(e.title),pageUrl:safeUrl(e.pageUrl),dwellIsEstimate:e.eventType==='page_engagement'},digest=hash(data);
        const previous=(await db.query('SELECT request_hash FROM marketing_events WHERE site_id=$1 AND event_id=$2',[site.id,e.eventId])).rows[0];
        if(previous){if(previous.request_hash!==digest)throw new ConflictException('Event id reused with different contents');accepted.push({eventId:e.eventId,duplicate:true});continue;}
        await db.query('INSERT INTO marketing_events(event_id,site_id,visitor_id,visit_id,event_type,request_hash,data,client_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[e.eventId,site.id,c.visitorId,c.visitId,e.eventType,digest,data,e.clientAt||null]);accepted.push({eventId:e.eventId,duplicate:false});
      }
      await db.query('UPDATE marketing_visits SET last_seen_at=now() WHERE id=$1',[c.visitId]);await db.query('UPDATE marketing_visitors SET last_seen_at=now() WHERE id=$1',[c.visitorId]);return {accepted};
    });
  }
  async publicForm(siteId:string,id:string,origin:string){
    await this.site(siteId,origin);const r=(await this.repo.db.query('SELECT f.id,f.name,f.published_version,v.definition FROM marketing_forms f JOIN marketing_form_versions v ON v.form_id=f.id AND v.version=f.published_version WHERE f.id=$1 AND f.site_id=$2',[z.uuid().parse(id),siteId])).rows[0];if(!r)throw new NotFoundException('Published form unavailable');return r;
  }
  async submit(input:unknown,origin:string){
    this.ready();const b=submissionSchema.parse(input),site=await this.site(b.siteId,origin),c=await this.claims(b.sessionToken,site.id);
    if(b.honeypot)throw new BadRequestException('Submission rejected');
    const f=(await this.repo.db.query('SELECT v.definition FROM marketing_form_versions v JOIN marketing_forms f ON f.id=v.form_id WHERE f.id=$1 AND f.site_id=$2 AND v.version=$3 AND f.published_version=v.version',[b.formId,site.id,b.version])).rows[0];if(!f)throw new ConflictException('Reload the published form');
    let fields:Record<string,string|boolean>;
    try{fields=validateFields(formSchema.parse(f.definition),b.fields);}catch{throw new BadRequestException('Check required form fields');}
    return this.repo.transaction('marketing-submit:'+site.id+':'+b.sourceSubmissionId,async db=>{
      const digest=hash({formId:b.formId,version:b.version,fields}),old=(await db.query('SELECT id,request_hash FROM marketing_inquiries WHERE site_id=$1 AND source_submission_id=$2',[site.id,b.sourceSubmissionId])).rows[0];
      if(old){if(old.request_hash!==digest)throw new ConflictException('Submission id reused');return {inquiryId:old.id,metaEventId:'inbox:website:lead:'+old.id,confirmed:true,duplicate:true};}
      const id=randomUUID();await db.query(`INSERT INTO marketing_inquiries(id,site_id,account_id,source_submission_id,source_kind,request_hash,payload,visitor_id,visit_id,consent_id,form_id,form_version)
        VALUES($1,$2,$3,$4,'form',$5,$6,$7,$8,$9,$10,$11)`,[id,site.id,site.account_id,b.sourceSubmissionId,digest,this.repo.pack({fields,definition:f.definition}),c.visitorId,c.visitId,c.consentId,b.formId,b.version]);
      if(c.visitorId)await db.query('INSERT INTO marketing_links(id,inquiry_id,visitor_id,basis,evidence,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),id,c.visitorId,'persisted_form_receipt',{submissionId:b.sourceSubmissionId,visitId:c.visitId},'system','Server persisted the submitted form']);
      await this.repo.job('marketing_intake','marketing-intake:'+id,null,null,null,{inquiryId:id},new Date(),db);
      return {inquiryId:id,metaEventId:'inbox:website:lead:'+id,confirmed:true,duplicate:false};
    });
  }
  async issueCode(input:unknown,origin:string){
    this.capture();if(process.env.WHATSAPP_REFERENCE_ENABLED!=='true')throw new ServiceUnavailableException('WhatsApp references disabled');
    const b=z.object({siteId:z.string(),sessionToken:z.string(),requestId:z.uuid(),bindingId:z.string().min(1).max(100)}).parse(input),site=await this.site(b.siteId,origin),c=await this.claims(b.sessionToken,site.id);
    if(!c.visitorId)throw new ConflictException('Reference unavailable without analytics consent');
    const binding=site.settings.whatsappBindings?.find((x:any)=>x.id===b.bindingId&&/^\d{7,15}$/.test(x.phone));if(!binding)throw new NotFoundException('Destination is not configured');
    return this.repo.transaction('marketing-code:'+site.id+':'+b.requestId,async db=>{
      const digest=hash({visitor:c.visitorId,visit:c.visitId,binding:b.bindingId}),old=(await db.query('SELECT * FROM marketing_short_codes WHERE site_id=$1 AND request_id=$2',[site.id,b.requestId])).rows[0];
      if(old&&old.request_hash!==digest)throw new ConflictException('Request id reused');
      const code=old?this.repo.unpack(old.code_ciphertext).code:shortCode(),expires=old?.expires_at||new Date(Date.now()+7*86400000);
      if(!old)await db.query('INSERT INTO marketing_short_codes(code_hash,code_ciphertext,site_id,request_id,request_hash,visitor_id,visit_id,binding_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[this.repo.identity('wa:'+code),this.repo.pack({code}),site.id,b.requestId,digest,c.visitorId,c.visitId,b.bindingId,expires]);
      return {code:'AKE-'+code,expiresAt:expires,state:old?.state||'issued',url:'https://wa.me/'+binding.phone+'?text='+encodeURIComponent('Hello, I would like to ask about your products. [AKE-'+code+']')};
    });
  }
  async trustedReceipt(input:any,origin:string){
    const digest=this.repo.identity('backend-receipt:'+input.siteId+':'+input.persistedReceiptId);
    const stableSubmission=digest.slice(0,8)+'-'+digest.slice(8,12)+'-4'+digest.slice(13,16)+'-8'+digest.slice(17,20)+'-'+digest.slice(20,32);
    let sessionToken=input.sessionToken;
    if(input.iframeToken){
      sessionToken=null;const token=readToken(String(input.iframeToken)),site=await this.site(input.siteId,origin);
      if(token?.kind==='iframe_receipt'&&token.siteId===site.id&&token.formId===input.formId&&token.childOrigin===input.iframeOrigin&&site.settings.iframeOrigins?.includes(token.childOrigin)){
        try{const context=this.repo.unpack(token.context);await this.claims(context.sessionToken,site.id);sessionToken=context.sessionToken;}catch{ /* Retain the true receipt with history unknown after revocation/expiry. */ }
      }
    }
    // A genuine backend receipt is still an inquiry when the browser SDK was blocked.
    // This receipt contains no visitor ID, visit ID, page event or inferred consent.
    if(!sessionToken){
      const consentId=randomUUID();await this.repo.db.query('INSERT INTO marketing_consents(id,site_id,choices,policy_version) VALUES($1,$2,$3,$4)',[consentId,input.siteId,consentSchema.parse({}),'backend_receipt_without_browser_evidence']);
      sessionToken=signToken({siteId:input.siteId,visitorId:null,visitId:null,consentId,exp:Date.now()+3600000});
    }
    const result=await this.submit({...input,sessionToken,sourceSubmissionId:stableSubmission},origin);
    if(!result.duplicate){await this.repo.db.query("UPDATE marketing_inquiries SET source_kind='backend_form' WHERE id=$1",[result.inquiryId]);await this.repo.audit('trusted_form_backend','marketing.persisted_receipt',result.inquiryId,{sourceReceiptHash:this.repo.identity(input.persistedReceiptId)});}
    return result;
  }
  async iframeContext(input:unknown,origin:string){
    const b=z.object({siteId:z.string(),sessionToken:z.string().max(2000),formId:z.uuid(),childOrigin:z.url()}).parse(input),site=await this.site(b.siteId,origin);
    if(new URL(b.childOrigin).origin!==b.childOrigin||!site.settings.iframeOrigins?.includes(b.childOrigin))throw new ForbiddenException('Embedded form origin is not registered');
    await this.claims(b.sessionToken,site.id);const form=await this.publicForm(site.id,b.formId,origin);
    // A child frame gets only a purpose-limited, encrypted context. It cannot
    // upload page events or declare success using this token.
    return {token:signToken({kind:'iframe_receipt',siteId:site.id,formId:b.formId,childOrigin:b.childOrigin,context:this.repo.pack({sessionToken:b.sessionToken}),exp:Date.now()+15*60000}),formId:b.formId,version:form.published_version};
  }
  async nativeActor(input:any):Promise<Actor>{
    this.ready();if(input.accountId!==config().accountId||!input.token)throw new ForbiddenException();
    const credentials={api_access_token:String(input.token)};let p:any;try{p=await this.cw.request('/api/v1/profile',undefined,'GET',credentials);}catch{throw new UnauthorizedException();}
    const membership=p.accounts?.find((x:any)=>x.id===config().accountId);if(!membership||p.id!==input.userId)throw new ForbiddenException();
    return {userId:p.id,accountId:config().accountId,role:membership.role,credentials};
  }
  async waha(operation:string,input:any){
    this.ready();if(process.env.WAHA_ENABLED!=='true')throw new ServiceUnavailableException('WAHA is disabled');
    if(operation==='receipt'){
      const b=z.object({key:z.string().max(160),state:z.enum(['accepted','review']),responseId:z.string().min(1).max(500).optional()}).parse(input);
      if(b.state==='accepted'&&!b.responseId)throw new BadRequestException('Persisted provider receipt required');
      const updated=(await this.repo.db.query("UPDATE marketing_waha_sends SET state=$2,response_id=$3,updated_at=now() WHERE key=$1 AND account_id=$4 AND state='processing' RETURNING inbox_id,message_id",[b.key,b.state,b.responseId||null,config().accountId])).rows[0];
      if(updated)await this.repo.db.query("UPDATE marketing_bridge_dispatches d SET state=CASE WHEN $4='review' THEN 'review' WHEN (SELECT count(*) FROM marketing_waha_sends s WHERE s.account_id=d.account_id AND s.inbox_id=d.inbox_id AND s.message_id=d.message_id AND s.state='accepted')=d.parts THEN 'accepted' ELSE d.state END,updated_at=now() WHERE d.account_id=$1 AND d.inbox_id=$2 AND d.message_id=$3",[config().accountId,updated.inbox_id,updated.message_id,b.state]);return {ok:true};
    }
    if(operation!=='claim')throw new NotFoundException();
    const b=z.object({accountId:z.number().int(),inboxId:z.number().int().positive(),conversationId:z.number().int().positive(),messageId:z.number().int().positive(),part:z.number().int().min(1).max(30),session:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),chatId:z.string().max(150),payloadHash:z.string().regex(/^[a-f0-9]{64}$/),nativeMessageHash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(input);
    if(b.accountId!==config().accountId||config().channels[String(b.inboxId)]!=='whatsapp')throw new ForbiddenException();
    let bindings:any[]=[];try{bindings=JSON.parse(process.env.WAHA_BINDINGS_JSON||'[]');}catch{}
    const binding=bindings.find(x=>x.session===b.session&&x.inboxId===b.inboxId);
    if(!binding||!binding.allowedPeerIds?.includes(b.chatId))return {allowed:false,reason:'test_destination_not_approved'};
    if(binding.paused===true)return {allowed:false,reason:'operator_channel_hold'};
    const native:any=await this.cw.account('/conversations/'+b.conversationId);if(native.inbox_id!==b.inboxId)throw new ForbiddenException();
    const destination=String(native.meta?.sender?.phone_number||'').replace(/\D/g,'');
    const verifiedDestination=binding.verifiedPeerMappings?.[b.chatId]||b.chatId.split('@')[0];
    if(!destination||destination!==verifiedDestination)return {allowed:false,reason:'contact_destination_mismatch'};
    const message=(await this.cw.messages(b.conversationId,undefined,true)).find(x=>Number(x.id)===b.messageId);
    if(!message||message.private||![1,'outgoing'].includes(message.message_type))throw new ForbiddenException('Persisted outgoing message required');
    const nativeHash=createHash('sha256').update(JSON.stringify({content:message.content??null,attachments:(message.attachments||[]).map((a:any)=>({id:Number(a.id),file_type:a.file_type,data_url:a.data_url})).sort((a:any,b:any)=>a.id-b.id)})).digest('hex');
    if(nativeHash!==b.nativeMessageHash)return {allowed:false,reason:'native_message_changed'};
    const attributes=message.content_attributes||{};
    const admission=await this.automation.admission(b.conversationId,attributes.ake_inbox_job,attributes.ake_inbox_revision);if(!admission.allowed)return admission;
    if(!await this.archivedMessage(message))return {allowed:false,reason:'archive_pending'};
    return this.repo.transaction('bridge:'+b.accountId+':'+b.inboxId,async db=>{
      const key='waha:'+b.accountId+':'+b.inboxId+':'+b.messageId+':'+b.part;
      const previous=(await db.query('SELECT * FROM marketing_waha_sends WHERE key=$1',[key])).rows[0];
      if(previous)return {allowed:false,key,state:previous.state,reason:previous.request_hash===b.payloadHash?'already_attempted':'payload_changed_requires_review'};
      const parts=(message.attachments||[]).length+(message.content&&(message.attachments||[]).length!==1?1:0);
      if(b.part>parts)return {allowed:false,reason:'invalid_part'};
      const owner=await new BridgeControl(this.repo).claim(db,{inboxId:b.inboxId,messageId:b.messageId,provider:'waha',parts});if(!owner.allowed)return owner;
      await db.query("INSERT INTO marketing_waha_sends(key,account_id,inbox_id,conversation_id,message_id,part,session,request_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'processing')",[key,b.accountId,b.inboxId,b.conversationId,b.messageId,b.part,b.session,b.payloadHash]);
      await this.repo.audit('waha_guard','marketing.waha_send_admitted',String(b.messageId),{key,session:b.session,inboxId:b.inboxId},db);return {allowed:true,key};
    });
  }
  async bridge(operation:string,input:any){
    this.ready();const b=z.object({inboxId:z.number().int().positive(),conversationId:z.number().int().positive(),messageId:z.number().int().positive(),nativeMessageHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),state:z.enum(['accepted','review']).optional()}).parse(input);
    if(config().channels[String(b.inboxId)]!=='whatsapp')throw new ForbiddenException();
    if(operation==='receipt'){
      if(!b.state)throw new BadRequestException();await this.repo.db.query("UPDATE marketing_bridge_dispatches SET state=$4,updated_at=now() WHERE account_id=$1 AND inbox_id=$2 AND message_id=$3 AND provider='evolution' AND state='processing'",[config().accountId,b.inboxId,b.messageId,b.state]);return {ok:true};
    }
    if(operation!=='claim')throw new NotFoundException();
    const conv:any=await this.cw.account('/conversations/'+b.conversationId);if(conv.inbox_id!==b.inboxId)throw new ForbiddenException();
    const m=(await this.cw.messages(b.conversationId,undefined,true)).find(m=>m.id===b.messageId);if(!m||m.private||![1,'outgoing'].includes(m.message_type))throw new ForbiddenException();
    const digest=createHash('sha256').update(JSON.stringify({content:m.content??null,attachments:(m.attachments||[]).map((a:any)=>({id:Number(a.id),file_type:a.file_type,data_url:a.data_url})).sort((a:any,b:any)=>a.id-b.id)})).digest('hex');
    if(digest!==b.nativeMessageHash)return {allowed:false,reason:'native_message_changed'};
    const a=await this.automation.admission(b.conversationId,m.content_attributes?.ake_inbox_job,m.content_attributes?.ake_inbox_revision);if(!a.allowed)return a;
    if(!await this.archivedMessage(m))return {allowed:false,reason:'archive_pending'};
    return this.repo.transaction('bridge:'+config().accountId+':'+b.inboxId,db=>new BridgeControl(this.repo).claim(db,{inboxId:b.inboxId,messageId:b.messageId,provider:'evolution',parts:1}));
  }
  private async archivedMessage(message:any){
    const root=config().archiveRoot;if(!root)return false;
    const directory=join(root,'messages',String(message.id));
    for(const name of await readdir(directory).catch(()=>[])){
      if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
      try{
        const bytes=await readFile(join(directory,name));if(createHash('sha256').update(bytes).digest('hex')!==name.slice(0,-5))continue;
        const snap=JSON.parse(bytes.toString());if(snap.record?.id!==Number(message.id)||snap.record?.content!==message.content)continue;
        const attachments=snap.attachments||[];if(attachments.length!==(message.attachments||[]).length)continue;
        let complete=true,total=0;
        if(attachments.length>10)return false;
        for(const a of attachments){
          if(a.archive_pending||!a.file||!/^blobs\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(a.file.path)){complete=false;break;}
          // Deliberate local transport policy, not a claim about provider limits.
          const maximum=Number(process.env.WAHA_MAX_ATTACHMENT_BYTES)||20*1024*1024;
          total+=Number(a.file.byte_size);if(a.file.byte_size>maximum||total>maximum*2)return false;
          const blob=await readFile(join(root,a.file.path));if(blob.length!==a.file.byte_size||createHash('sha256').update(blob).digest('hex')!==a.file.sha256){complete=false;break;}
        }
        if(complete)return true;
      }catch{ /* A partial archive is a retryable admission failure, never permission to send. */ }
    }return false;
  }
  // Only persisted, authenticated native incoming messages can claim a website code.
  // The reference connects evidence, never merges Chatwoot contacts or CRM customers.
  async observeInbound(body:any){
    if(body.event!=='message_created'||![0,'incoming'].includes(body.message_type)||body.private===true)return {ignored:true};
    const accountId=Number(body.account?.id),cid=Number(body.conversation?.id),mid=Number(body.id),inboxId=Number(body.inbox?.id??body.conversation?.inbox_id);
    if(accountId!==config().accountId||!Number.isSafeInteger(mid)||!config().channels[String(inboxId)])return {ignored:true};
    const old=(await this.repo.db.query('SELECT result FROM marketing_inbound_claims WHERE account_id=$1 AND inbox_id=$2 AND message_id=$3',[accountId,inboxId,String(mid)])).rows[0];if(old)return {...old.result,duplicate:true};
    const conv:any=await this.cw.account('/conversations/'+cid);
    if(conv.inbox_id!==inboxId)throw new ForbiddenException('Inbound scope mismatch');
    const message=(await this.cw.messages(cid,undefined,true)).find((m:any)=>Number(m.id)===mid);
    if(!message||![0,'incoming'].includes(message.message_type)||message.private)throw new ConflictException('Persisted incoming message required');
    const contactId=Number(conv.meta?.sender?.id);if(!contactId)throw new ConflictException('Native sender required');
    if(conv.additional_attributes?.ake_inquiry_id){return {inquiryId:conv.additional_attributes.ake_inquiry_id,source:'form'};}
    const channel=config().channels[String(inboxId)],codes=channel==='whatsapp'&&process.env.WHATSAPP_REFERENCE_ENABLED==='true'?codeFromMessage(String(message.content||'')):[];
    const sites=(await this.repo.db.query('SELECT * FROM marketing_sites WHERE account_id=$1 AND enabled=true',[accountId])).rows;
    const site=sites.find(s=>Number(s.inbox_id)===inboxId||s.settings.whatsappBindings?.some((x:any)=>Number(x.inboxId)===inboxId));
    if(!site)return {ignored:true,reason:'site_mapping_missing'};
    return this.repo.transaction('marketing-native:'+accountId,async db=>{
      const duplicate=(await db.query('SELECT result FROM marketing_inbound_claims WHERE account_id=$1 AND inbox_id=$2 AND message_id=$3',[accountId,inboxId,String(mid)])).rows[0];if(duplicate)return {...duplicate.result,duplicate:true};
      let state=codes.length>1?'conflict':codes.length?'invalid':'missing',code:any=null;
      if(codes.length===1){code=(await db.query('SELECT * FROM marketing_short_codes WHERE code_hash=$1 FOR UPDATE',[this.repo.identity('wa:'+codes[0])])).rows[0];
        if(code&&code.site_id===site.id&&site.settings.whatsappBindings?.some((x:any)=>x.id===code.binding_id&&Number(x.inboxId)===inboxId)){
          const visitor=(await db.query('SELECT * FROM marketing_visitors WHERE id=$1 AND revoked_at IS NULL',[code.visitor_id])).rows[0];
          state=code.state==='conflict'?'conflict':new Date(code.expires_at).getTime()<Date.now()?'expired':!visitor?'consent_revoked':code.claimed_contact_id&&Number(code.claimed_contact_id)!==contactId?'conflict':'confirmed';
        }else code=null;
      }
      let existing=(await db.query('SELECT * FROM marketing_inquiries WHERE account_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT 1',[accountId,cid])).rows[0];
      if(code?.inquiry_id&&state==='confirmed')existing=(await db.query('SELECT * FROM marketing_inquiries WHERE id=$1',[code.inquiry_id])).rows[0];
      const newCase=!existing||(state==='confirmed'&&existing.visitor_id&&existing.visit_id!==code.visit_id)||state==='conflict';
      const id=newCase?randomUUID():existing.id;
      if(newCase){
        const definition={fields:[{key:'message',mapping:'message'},{key:'name',mapping:'name'}]};
        await db.query(`INSERT INTO marketing_inquiries(id,site_id,account_id,source_submission_id,source_kind,request_hash,payload,contact_id,conversation_id,message_id,identity_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,site.id,accountId,'native:'+inboxId+':'+mid,channel,hash({mid,cid,inboxId}),this.repo.pack({definition,fields:{message:String(message.content||'').slice(0,16000),name:String(conv.meta.sender.name||'Inbound visitor')}}),contactId,cid,mid,state==='conflict'?'conflict':'channel_identity']);
      }
      if(state==='confirmed'&&code){
        if(existing?.visitor_id&&existing.visitor_id!==code.visitor_id)state='conflict';
        else {
          const visitor=(await db.query('SELECT consent_id FROM marketing_visitors WHERE id=$1',[code.visitor_id])).rows[0];
          await db.query('UPDATE marketing_inquiries SET visitor_id=$2,visit_id=$3,consent_id=$4,revision=revision+1 WHERE id=$1',[id,code.visitor_id,code.visit_id,visitor.consent_id]);
          await db.query("UPDATE marketing_short_codes SET state='claimed',inquiry_id=$2,claimed_contact_id=$3 WHERE code_hash=$1",[code.code_hash,id,contactId]);
          await db.query('INSERT INTO marketing_links(id,inquiry_id,visitor_id,basis,evidence,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),id,code.visitor_id,'whatsapp_inbound_reference',{messageId:mid,conversationId:cid,inboxId,visitId:code.visit_id},'system','Reference observed in a persisted incoming message; no identity merge']);
        }
      }
      if(state==='conflict'){
        if(code)await db.query("UPDATE marketing_short_codes SET state='conflict' WHERE code_hash=$1",[code.code_hash]);
        await db.query("UPDATE marketing_inquiries SET identity_state='conflict',visitor_id=NULL,visit_id=NULL,revision=revision+1 WHERE id=$1 OR id=$2",[id,code?.inquiry_id||null]);
        await this.repo.audit('system','marketing.reference_conflict',id,{messageId:mid,inboxId},db);
      }
      await this.repo.job('marketing_intake','marketing-intake:'+id,cid,null,null,{inquiryId:id},new Date(),db);
      const result={inquiryId:id,reference:state};await db.query('INSERT INTO marketing_inbound_claims(account_id,inbox_id,message_id,result) VALUES($1,$2,$3,$4)',[accountId,inboxId,String(mid),result]);return result;
    });
  }
  private async inquiry(actor:Actor,id:string){
    const row=(await this.repo.db.query('SELECT * FROM marketing_inquiries WHERE id=$1 AND account_id=$2',[z.uuid().parse(id),actor.accountId])).rows[0];if(!row)throw new NotFoundException();
    if(row.conversation_id)await this.cw.allowed(actor,Number(row.conversation_id));else this.admin(actor);return row;
  }
  private page(input:any,scope:string,accountId:number){
    const b=z.object({limit:z.number().int().min(1).max(200).default(50),cursor:z.string().max(4000).optional()}).parse(input||{});
    const c=b.cursor?readToken(b.cursor):null;
    if(b.cursor&&(!c||c.kind!=='marketing_page'||c.scope!==scope||c.accountId!==accountId))throw new BadRequestException('Invalid or expired page cursor');
    return {limit:b.limit,at:c?.at||null,id:c?.id||null};
  }
  private cursor(scope:string,accountId:number,at:string,id:string){return signToken({kind:'marketing_page',scope,accountId,at,id,exp:Date.now()+3600000});}
  async timeline(visitorId:string,input:any={}){
    const page=this.page(input,'timeline:'+visitorId,config().accountId);
    const v=(await this.repo.db.query('SELECT v.*,s.account_id FROM marketing_visitors v JOIN marketing_sites s ON s.id=v.site_id WHERE v.id=$1 AND s.account_id=$2',[z.uuid().parse(visitorId),config().accountId])).rows[0];if(!v)throw new NotFoundException();
    const visits=(await this.repo.db.query('SELECT * FROM marketing_visits WHERE visitor_id=$1 ORDER BY started_at,id',[visitorId])).rows.map(x=>({...x,current_touch:this.displayTouch(x.current_touch)}));
    const rows=(await this.repo.db.query('SELECT sequence,event_id,visit_id,event_type,data,client_at,received_at FROM marketing_events WHERE visitor_id=$1 AND sequence>COALESCE($2::bigint,0) ORDER BY sequence LIMIT $3',[visitorId,page.id,page.limit+1])).rows;
    const events=rows.slice(0,page.limit),last=events.at(-1),nextCursor=rows.length>page.limit?this.cursor('timeline:'+visitorId,config().accountId,'sequence',String(last.sequence)):null;
    return {visitor:{id:v.id,firstTouch:this.displayTouch(v.first_touch),createdAt:v.created_at,lastSeenAt:v.last_seen_at,trackingStoppedAt:v.revoked_at},visits,events,nextCursor,limited:!!nextCursor,limit:page.limit};
  }
  async action(actor:Actor,action:string,input:any){
    this.ready();if(process.env.ATTRIBUTION_UI_ENABLED!=='true')throw new ServiceUnavailableException('Marketing UI disabled');
    if(action==='meta_feedback') { this.admin(actor); const meta=new MetaFeedback(this.repo);return {settings:meta.publicSettings(),receipts:await meta.rows(actor.accountId)}; }
    if(action==='meta_prepare'||action==='meta_send') {
      this.admin(actor);const row=await this.inquiry(actor,action==='meta_prepare'?input.id:input.inquiryId);
      try { const meta=new MetaFeedback(this.repo);return action==='meta_prepare'?await meta.prepare(actor,row,input):await meta.send(actor,row,input.feedbackId); }
      catch(e) {
        if(e instanceof z.ZodError)return {metaError:'请核对来源、阶段、日期和核验依据是否填写完整'};
        if(e instanceof BadRequestException||e instanceof ConflictException||e instanceof ServiceUnavailableException)return {metaError:e.message};
        throw e;
      }
    }
    if(action==='overview'){this.admin(actor);return this.overview();}
    if(action==='bridge_transition'){this.admin(actor);if(config().channels[String(input.inboxId)]!=='whatsapp')throw new ForbiddenException();return new BridgeControl(this.repo).transition(actor,input);}
    if(action==='bridge_status'){this.admin(actor);return {bridges:(await this.repo.db.query('SELECT inbox_id,provider,revision,cutoff_message_id,updated_at FROM marketing_bridge_owners WHERE account_id=$1',[actor.accountId])).rows};}
    if(action==='sites'){this.admin(actor);return {sites:(await this.repo.db.query('SELECT id,name,origin,inbox_id,settings FROM marketing_sites WHERE account_id=$1',[actor.accountId])).rows,role:actor.role};}
    if(action==='visitors'){
      this.admin(actor);const p=this.page(input,action,actor.accountId),rows=(await this.repo.db.query(`SELECT v.*,v.last_seen_at::text AS page_at,s.name AS site_name,(SELECT count(*)::int FROM marketing_events e WHERE e.visitor_id=v.id AND e.event_type='page_view') AS pageviews FROM marketing_visitors v JOIN marketing_sites s ON s.id=v.site_id WHERE s.account_id=$1 AND ($2::timestamptz IS NULL OR (v.last_seen_at,v.id)<($2::timestamptz,$3::uuid)) ORDER BY v.last_seen_at DESC,v.id DESC LIMIT $4`,[actor.accountId,p.at,p.id,p.limit+1])).rows;
      const visible=rows.slice(0,p.limit),last=visible.at(-1);return {visitors:visible.map(({page_at,...v})=>({...v,first_touch:this.displayTouch(v.first_touch)})),limit:p.limit,nextCursor:rows.length>p.limit?this.cursor(action,actor.accountId,last.page_at,last.id):null};
    }
    if(action==='visitor'){this.admin(actor);return this.timeline(input.id,input);}
    if(action==='inquiry_timeline'){const row=await this.inquiry(actor,input.id);return row.visitor_id?this.timeline(row.visitor_id,input):null;}
    if(action==='inquiries'){
      if(input.conversationId)await this.cw.allowed(actor,Number(input.conversationId));
      const scope='inquiries:'+actor.userId+':'+(input.conversationId||'')+':'+(input.contactId||''),p=this.page(input,scope,actor.accountId),allowed:any[]=[],permissions=new Map<number,boolean>();let at=p.at,id=p.id,more=false;
      // Continue beyond unauthorized rows. A bounded scan always returns a cursor,
      // so an agent can reach older authorized inquiries without exposing others.
      for(let batch=0;batch<5;batch++){
        const rows=(await this.repo.db.query(`SELECT i.*,i.created_at::text AS page_at,s.name AS site_name,v.first_touch,vi.current_touch FROM marketing_inquiries i JOIN marketing_sites s ON s.id=i.site_id LEFT JOIN marketing_visitors v ON v.id=i.visitor_id LEFT JOIN marketing_visits vi ON vi.id=i.visit_id WHERE i.account_id=$1 AND ($2::bigint IS NULL OR i.conversation_id=$2) AND ($3::bigint IS NULL OR i.contact_id=$3) AND ($4::timestamptz IS NULL OR (i.created_at,i.id)<($4::timestamptz,$5::uuid)) ORDER BY i.created_at DESC,i.id DESC LIMIT 200`,[actor.accountId,input.conversationId||null,input.contactId||null,at,id])).rows;
        more=rows.length===200;
        for(let n=0;n<rows.length;n++){
          const r=rows[n];at=r.page_at;id=r.id;let permitted=actor.role==='administrator';
          if(!permitted&&r.conversation_id){const cid=Number(r.conversation_id);if(!permissions.has(cid)){try{await this.cw.allowed(actor,cid);permissions.set(cid,true);}catch{permissions.set(cid,false);}}permitted=permissions.get(cid)===true;}
          if(permitted){const {payload,request_hash,page_at,...safe}=r;allowed.push({...safe,first_touch:this.displayTouch(r.first_touch),current_touch:this.displayTouch(r.current_touch),summary:this.summary(this.repo.unpack(payload))});}
          if(allowed.length===p.limit){more=more||n<rows.length-1;break;}
        }
        if(allowed.length===p.limit||!more)break;
      }
      return {inquiries:allowed,role:actor.role,limit:p.limit,nextCursor:more?this.cursor(scope,actor.accountId,at,id):null};
    }
    if(action==='inquiry'){
      const row=await this.inquiry(actor,input.id),links=(await this.repo.db.query('SELECT * FROM marketing_links WHERE inquiry_id=$1 ORDER BY created_at,id',[row.id])).rows;
      const timeline=row.visitor_id?await this.timeline(row.visitor_id):null;const {payload,request_hash,...safe}=row;
      const crm=row.contact_id?(await this.repo.db.query('SELECT l.lead_id,l.company_id,c.identity_verified,c.identity_conflict FROM inbox_v2_contacts c LEFT JOIN inbox_v2_links l USING(account_id,group_key) WHERE c.account_id=$1 AND c.contact_id=$2',[actor.accountId,row.contact_id])).rows[0]:null;
      const meta=new MetaFeedback(this.repo);
      return {inquiry:safe,submission:this.repo.unpack(payload),links,timeline,crm:crm||null,coverage:row.visitor_id?'observed':'history_unknown',receipts:row.lead_id?await this.receipts(row.lead_id):[],role:actor.role,meta:actor.role==='administrator'?{settings:meta.publicSettings(),receipts:await meta.rows(actor.accountId,row.id)}:undefined};
    }
    if(action==='forms'){this.admin(actor);return {forms:(await this.repo.db.query('SELECT f.* FROM marketing_forms f JOIN marketing_sites s ON s.id=f.site_id WHERE s.account_id=$1 ORDER BY f.created_at DESC',[actor.accountId])).rows};}
    if(action==='identity_preview'){
      const cid=z.number().int().positive().parse(input.conversationId);await this.cw.allowed(actor,cid);const c=await this.repo.conversation(cid);if(!c)throw new ConflictException('Waiting for native intake');
      const identity=(await this.repo.db.query('SELECT identity_conflict,identity_verified FROM inbox_v2_contacts WHERE account_id=$1 AND contact_id=$2',[actor.accountId,c.contact_id])).rows[0];
      return {conversationId:cid,revision:c.revision,channel:c.channel,identityConflict:identity?.identity_conflict===true,identityVerified:identity?.identity_verified===true};
    }
    if(action==='link_identity')return this.automation.linkIdentity(actor,input);
    if(action==='save_form')return this.saveForm(actor,input);
    if(action==='publish_form')return this.publishForm(actor,input);
    if(action==='correct_link')return this.correctLink(actor,input);
    if(action==='qualify')return this.qualify(actor,input);
    if(action==='new_case'){
      const b=z.object({id:z.uuid(),messageId:z.number().int().positive(),requestId:z.uuid(),reason:z.string().min(8).max(500)}).parse(input),original=await this.inquiry(actor,b.id);
      if(!original.conversation_id)throw new ConflictException('Native conversation required');
      const m=(await this.cw.messages(Number(original.conversation_id),actor.credentials,true)).find(x=>x.id===b.messageId&&[0,'incoming'].includes(x.message_type)&&!x.private);if(!m)throw new ConflictException('Select a persisted incoming message in this conversation');
      return this.repo.actionOnce('marketing-new-case:'+b.requestId,hash(b),async db=>{const id=randomUUID();
        await db.query(`INSERT INTO marketing_inquiries(id,site_id,account_id,source_submission_id,source_kind,request_hash,payload,contact_id,conversation_id,message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,original.site_id,actor.accountId,'manual-case:'+b.requestId,original.source_kind,hash(b),this.repo.pack({definition:{fields:[{key:'message',mapping:'message'}]},fields:{message:String(m.content||'')}}),original.contact_id,original.conversation_id,b.messageId]);
        await this.repo.job('marketing_intake','marketing-intake:'+id,Number(original.conversation_id),null,null,{inquiryId:id},new Date(),db);await this.repo.audit(String(actor.userId),'marketing.new_inquiry_case',id,{originalInquiry:original.id,messageId:b.messageId,reason:b.reason},db);return {id};
      });
    }
    if(action==='receipts'){this.admin(actor);const p=this.page(input,action,actor.accountId),rows=(await this.repo.db.query('SELECT d.id,d.created_at::text AS page_at,d.event_key,d.mode,d.status,d.receipt_stages,d.provider_response_id,d.attempt_count,d.provider_error_code,d.skipped_reason,d.updated_at,i.id AS inquiry_id FROM conversion_deliveries d JOIN marketing_inquiries i ON i.lead_id=d.primary_source_lead_id WHERE i.account_id=$1 AND ($2::timestamptz IS NULL OR (d.created_at,d.id)<($2::timestamptz,$3::text)) ORDER BY d.created_at DESC,d.id DESC LIMIT $4',[actor.accountId,p.at,p.id,p.limit+1])).rows,visible=rows.slice(0,p.limit),last=visible.at(-1);return {receipts:visible.map(({page_at,...r})=>r),limit:p.limit,nextCursor:rows.length>p.limit?this.cursor(action,actor.accountId,last.page_at,last.id):null};}
    if(action==='retry_intake'){this.admin(actor);const row=await this.inquiry(actor,input.id);await this.repo.db.query("UPDATE inbox_v2_jobs SET state='pending',due_at=now(),error=NULL WHERE id=$1 AND state='review'",['marketing-intake:'+row.id]);await this.repo.audit(String(actor.userId),'marketing.intake_retry',row.id);return {ok:true};}
    throw new NotFoundException('Unknown marketing action');
  }
  private summary(payload:any){const def=payload?.definition;return def?.fields?.filter((f:any)=>['name','company','message'].includes(f.mapping)).map((f:any)=>String(payload.fields?.[f.key]||'')).filter(Boolean).join(' · ').slice(0,180)||'Incoming inquiry';}
  private async saveForm(actor:Actor,input:any){
    this.admin(actor);const b=z.object({id:z.uuid().optional(),siteId:z.string(),name:z.string().min(1).max(100),expectedRevision:z.number().int().min(0),definition:formSchema}).parse(input);await this.site(b.siteId);
    return this.repo.transaction('marketing-form:'+(b.id||b.siteId),async db=>{const id=b.id||randomUUID();
      if(b.id){const old=(await db.query('SELECT f.* FROM marketing_forms f JOIN marketing_sites s ON s.id=f.site_id WHERE f.id=$1 AND s.account_id=$2 FOR UPDATE OF f',[id,actor.accountId])).rows[0];if(!old||old.site_id!==b.siteId)throw new NotFoundException();if(old.revision!==b.expectedRevision)throw new ConflictException('Refresh before saving');await db.query('UPDATE marketing_forms SET name=$2,draft=$3,revision=revision+1 WHERE id=$1',[id,b.name,b.definition]);}
      else await db.query('INSERT INTO marketing_forms(id,site_id,name,draft) VALUES($1,$2,$3,$4)',[id,b.siteId,b.name,b.definition]);
      await this.repo.audit(String(actor.userId),'marketing.form_saved',id,{},db);return {id};});
  }
  private async publishForm(actor:Actor,input:any){
    this.admin(actor);const b=z.object({id:z.uuid(),expectedRevision:z.number().int()}).parse(input);
    return this.repo.transaction('marketing-form:'+b.id,async db=>{const f=(await db.query('SELECT f.* FROM marketing_forms f JOIN marketing_sites s ON s.id=f.site_id WHERE f.id=$1 AND s.account_id=$2 FOR UPDATE OF f',[b.id,actor.accountId])).rows[0];if(!f)throw new NotFoundException();if(f.revision!==b.expectedRevision)throw new ConflictException('Refresh before publishing');
      const version=(f.published_version||0)+1;await db.query('INSERT INTO marketing_form_versions(form_id,version,definition,published_by) VALUES($1,$2,$3,$4)',[f.id,version,formSchema.parse(f.draft),actor.userId]);await db.query('UPDATE marketing_forms SET published_version=$2,revision=revision+1 WHERE id=$1',[f.id,version]);await this.repo.audit(String(actor.userId),'marketing.form_published',f.id,{version},db);return {id:f.id,version};});
  }
  private async correctLink(actor:Actor,input:any){
    const b=z.object({id:z.uuid(),visitorId:z.uuid().nullable(),visitId:z.uuid().nullable().optional(),resolveConflict:z.boolean().optional(),expectedRevision:z.number().int(),requestId:z.uuid(),reason:z.string().trim().min(8).max(500),evidenceRefs:z.array(z.string().min(1).max(200)).min(1).max(10)}).parse(input);const row=await this.inquiry(actor,b.id);
    // Connecting previously anonymous history requires site-level access. Agents can unlink an incorrect link.
    if(b.visitorId||b.resolveConflict)this.admin(actor);
    return this.repo.actionOnce('marketing-correction:'+b.requestId,hash(b),async db=>{
      const latest=(await db.query('SELECT * FROM marketing_inquiries WHERE id=$1 FOR UPDATE',[row.id])).rows[0];if(latest.revision!==b.expectedRevision)throw new ConflictException('Refresh before correcting');
      if(b.visitorId){const v=(await db.query('SELECT id FROM marketing_visitors WHERE id=$1 AND site_id=$2',[b.visitorId,row.site_id])).rows[0];if(!v)throw new ForbiddenException('Visitor belongs to another site');}
      if(b.visitId){const v=(await db.query('SELECT id FROM marketing_visits WHERE id=$1 AND visitor_id=$2 AND site_id=$3',[b.visitId,b.visitorId,row.site_id])).rows[0];if(!v)throw new ForbiddenException('Visit does not belong to this visitor and site');}
      const prev=(await db.query('SELECT id FROM marketing_links WHERE inquiry_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[row.id])).rows[0];
      await db.query('INSERT INTO marketing_links(id,inquiry_id,visitor_id,basis,evidence,actor_id,reason,supersedes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),row.id,b.visitorId,'human_review',JSON.stringify(b.evidenceRefs),String(actor.userId),b.reason,prev?.id||null]);await db.query("UPDATE marketing_inquiries SET visitor_id=$2,visit_id=$3,identity_state=CASE WHEN $4 THEN 'human_review' ELSE identity_state END,revision=revision+1 WHERE id=$1",[row.id,b.visitorId,b.visitId||null,b.resolveConflict===true]);
      await db.query("UPDATE conversion_deliveries SET status='skipped',skipped_reason='attribution_corrected_before_upload',updated_at=now() WHERE primary_source_lead_id=$1 AND status IN ('pending','retrying')",[row.lead_id]);
      await this.repo.audit(String(actor.userId),'marketing.link_corrected',row.id,{reason:b.reason,evidenceRefs:b.evidenceRefs},db);return {ok:true,revision:latest.revision+1};
    });
  }
  private async qualify(actor:Actor,input:any){
    if(process.env.QUALIFIED_FEEDBACK_ENABLED!=='true')throw new ServiceUnavailableException('Qualification disabled');
    const b=z.object({id:z.uuid(),expectedRevision:z.number().int(),requestId:z.uuid(),contactReachable:z.literal(true),relevantNeed:z.literal(true),targetBuyer:z.literal(true),nextAction:z.string().trim().min(3).max(500),evidenceRefs:z.array(z.string().min(1).max(200)).min(1).max(10)}).parse(input),row=await this.inquiry(actor,b.id);
    if(!row.lead_id||!row.message_id||row.identity_state==='conflict'||(row.contact_id&&(await this.repo.db.query('SELECT identity_conflict FROM inbox_v2_contacts WHERE account_id=$1 AND contact_id=$2',[actor.accountId,row.contact_id])).rows[0]?.identity_conflict))throw new ConflictException('Confirmed receipt and resolved identity are required');
    return this.repo.transaction('marketing-qualify:'+row.id,async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['inbox-v2:intake:'+actor.accountId]);
      const current=(await db.query('SELECT * FROM marketing_inquiries WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
      if(current.identity_state==='conflict'||(current.contact_id&&(await db.query('SELECT identity_conflict FROM inbox_v2_contacts WHERE account_id=$1 AND contact_id=$2',[actor.accountId,current.contact_id])).rows[0]?.identity_conflict))throw new ConflictException('Resolve the identity conflict before qualification');
      if(current.qualified_at)return {qualified:true,duplicate:true,receipts:await this.receipts(row.lead_id)};
      if(current.revision!==b.expectedRevision)throw new ConflictException('Refresh before qualification');
      const result=await this.revenue.qualifyLead({workspaceId:loadConfig().defaultWorkspaceId,leadId:row.lead_id,actorId:String(actor.userId),...b});
      await db.query('UPDATE marketing_inquiries SET qualified_at=now(),state=\'qualified\',revision=revision+1 WHERE id=$1',[row.id]);await this.repo.audit(String(actor.userId),'marketing.lead_qualified',row.id,{eventKey:result.delivery.eventId,evidenceRefs:b.evidenceRefs,nextAction:b.nextAction},db);return {qualified:true,eventKey:result.delivery.eventId,duplicate:result.deduplicated};});
  }
  private async receipts(leadId:string){return (await this.repo.db.query('SELECT id,event_key,mode,status,receipt_stages,provider_response_id,attempt_count,provider_error_code,skipped_reason,updated_at FROM conversion_deliveries WHERE primary_source_lead_id=$1 ORDER BY created_at',[leadId])).rows;}
  private async overview(){
    const a=config().accountId;
    const totals=(await this.repo.db.query(`SELECT
      (SELECT count(*)::int FROM marketing_visitors v JOIN marketing_sites s ON s.id=v.site_id WHERE s.account_id=$1) AS visitors,
      (SELECT count(*)::int FROM marketing_visits v JOIN marketing_sites s ON s.id=v.site_id WHERE s.account_id=$1) AS visits,
      (SELECT count(*)::int FROM marketing_events e JOIN marketing_sites s ON s.id=e.site_id WHERE s.account_id=$1 AND e.event_type='page_view') AS pageviews,
      (SELECT count(*)::int FROM marketing_events e JOIN marketing_sites s ON s.id=e.site_id WHERE s.account_id=$1 AND e.event_type='contact_click') AS contact_clicks,
      (SELECT count(*)::int FROM marketing_events e JOIN marketing_sites s ON s.id=e.site_id WHERE s.account_id=$1 AND e.event_type='form_submit_attempt') AS submit_attempts,
      (SELECT count(*)::int FROM marketing_inquiries WHERE account_id=$1) AS inquiries,
      (SELECT count(*)::int FROM marketing_inquiries WHERE account_id=$1 AND qualified_at IS NOT NULL) AS qualified,
      (SELECT count(DISTINCT visit_id)::int FROM marketing_inquiries WHERE account_id=$1 AND visit_id IS NOT NULL) AS inquiring_visits`,[a])).rows[0];
    const sources=(await this.repo.db.query(`SELECT v.current_touch->>'source' AS source,count(DISTINCT v.id)::int AS visits,count(DISTINCT i.id)::int AS inquiries,count(DISTINCT i.id) FILTER(WHERE i.qualified_at IS NOT NULL)::int AS qualified FROM marketing_visits v JOIN marketing_sites s ON s.id=v.site_id LEFT JOIN marketing_inquiries i ON i.visit_id=v.id WHERE s.account_id=$1 GROUP BY v.current_touch->>'source' ORDER BY visits DESC`,[a])).rows;
    const crm=(await this.repo.db.query('SELECT count(DISTINCT i.id)::int AS linked FROM marketing_inquiries i JOIN inbox_v2_contacts c ON c.account_id=i.account_id AND c.contact_id=i.contact_id JOIN inbox_v2_links l ON l.account_id=c.account_id AND l.group_key=c.group_key WHERE i.account_id=$1 AND l.company_id IS NOT NULL',[a])).rows[0];
    return {totals:{...totals,crmLinked:crm.linked,crmConverted:null,visitInquiryRate:totals.visits?totals.inquiring_visits/totals.visits:null},sources,definitions:{inquiries:'Persisted genuine inbound receipts; clicks and attempts are excluded.',visitInquiryRate:'Distinct linked visits with at least one confirmed inquiry / observed visits.',history:'Only consented, observed visits are counted. Unobserved history is unknown.',crmConverted:'Unknown until a verified CRM conversion receipt exists.',dwell:'Estimated time while the page is visible; not proof of attention.'},mode:loadConfig().adsMode};
  }
  async intakeTick(){
    if(this.busy||process.env.MARKETING_ENABLED!=='true')return;this.busy=true;
    try{const job=await this.repo.claim(['marketing_intake']);if(!job)return;
      try{
        const {inquiryId}=this.repo.unpack(job.payload),row=(await this.repo.db.query('SELECT i.*,s.inbox_id,s.settings FROM marketing_inquiries i JOIN marketing_sites s ON s.id=i.site_id WHERE i.id=$1 AND i.account_id=$2',[inquiryId,config().accountId])).rows[0];if(!row)throw new Error('inquiry_missing');
        const body=this.repo.unpack(row.payload),form=body.definition;
        const mapped=Object.fromEntries((form?.fields||[]).filter((f:any)=>f.mapping!=='custom').map((f:any)=>[f.mapping,body.fields?.[f.key]]));
        let receipt:any={messageId:row.message_id,conversationId:row.conversation_id,contactId:row.contact_id};
        if(!row.message_id){const response=await fetch(config().chatwootUrl+'/api/v1/ake_marketing/intake',{method:'POST',headers:{'content-type':'application/json','x-inbox-key':config().internalKey},signal:AbortSignal.timeout(18000),body:JSON.stringify({accountId:row.account_id,inboxId:row.inbox_id,inquiryId:row.id,visitorReference:row.visitor_id?this.repo.identity(row.site_id+':'+row.visitor_id):row.id,summary:this.summary(body),fields:body.fields||{},name:mapped.name||'Website visitor'})});
          if(!response.ok)throw new Error('native_intake_http_'+response.status);receipt=await response.json();}
        if(!receipt.messageId||!receipt.conversationId||!receipt.contactId)throw new Error('native_receipt_incomplete');
        let leadId=row.lead_id;
        if(!leadId){
          const visit=row.visit_id?(await this.repo.db.query('SELECT current_touch FROM marketing_visits WHERE id=$1',[row.visit_id])).rows[0]?.current_touch:null;
          const consent=row.consent_id?(await this.repo.db.query('SELECT choices FROM marketing_consents WHERE id=$1',[row.consent_id])).rows[0]?.choices:null;
          const sourceKind: 'website'|'whatsapp'|'email'=row.source_kind==='whatsapp'?'whatsapp':row.source_kind==='email'?'email':'website';
          const ids=visit?.identifiersCipher?this.repo.unpack(visit.identifiersCipher):{},{provider,identifiers}=marketingAttribution(ids);
          const lead=await this.revenue.ingestLead({workspaceId:loadConfig().defaultWorkspaceId,provider,sourceKind,externalLeadId:'marketing:'+row.site_id+':'+row.id,displayName:String(mapped.name||'Website inquiry'),isTest:process.env.MARKETING_TEST_MODE==='true',attribution:{provider,sourceKind,occurredAt:new Date(row.created_at).toISOString(),identifiers,utm:visit?.utm||{},landingUrl:visit?.pageUrl,referrer:visit?.referrer,consentStatus:consent?.adStorage==='granted'&&consent?.adUserData==='granted'?'granted':'unknown',metadata:{consent:consent||{},inquiryId:row.id,identityVerification:'unverified'}}});
          leadId=lead.id;
        }
        await this.repo.transaction('marketing-intake:'+row.id,async db=>{await db.query('UPDATE marketing_inquiries SET contact_id=$2,conversation_id=$3,message_id=$4,lead_id=$5,state=CASE WHEN qualified_at IS NULL THEN \'received\' ELSE state END WHERE id=$1',[row.id,receipt.contactId,receipt.conversationId,receipt.messageId,leadId]);await this.repo.finish(job.id,'done',{inquiryId:row.id,...receipt},null,db);});
      }catch{if(job.attempts<5)await this.repo.db.query("UPDATE inbox_v2_jobs SET state='pending',due_at=now()+($2||' seconds')::interval,error='native_receipt_retry' WHERE id=$1",[job.id,Math.min(60,2**job.attempts)]);else await this.repo.finish(job.id,'review',{},'native_receipt_requires_review');}
    }finally{this.busy=false;}
  }
  async prune(){
    if(Date.now()-this.maintenanceAt<3600000)return;this.maintenanceAt=Date.now();
    await this.repo.db.query("UPDATE marketing_waha_sends SET state='review',updated_at=now() WHERE account_id=$1 AND state='processing' AND updated_at<now()-interval '5 minutes'",[config().accountId]);
    for(const s of (await this.repo.db.query('SELECT id,settings FROM marketing_sites WHERE account_id=$1',[config().accountId])).rows){
      await this.repo.db.query("DELETE FROM marketing_visitors v WHERE site_id=$1 AND last_seen_at<now()-($2||' days')::interval AND NOT EXISTS(SELECT 1 FROM marketing_inquiries i WHERE i.visitor_id=v.id) AND NOT EXISTS(SELECT 1 FROM marketing_links l WHERE l.visitor_id=v.id)",[s.id,Number(s.settings.retentionDays||90)]);
    }
  }
  onApplicationBootstrap(){if(process.env.MARKETING_ENABLED==='true'){this.timer=setInterval(()=>{void this.intakeTick().catch(()=>undefined);void this.prune().catch(()=>undefined);},1000);this.timer.unref();}}
  onModuleDestroy(){if(this.timer)clearInterval(this.timer);}
}
