import { Injectable, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { InboxRepository } from './repository';
import { config, type OpportunityInput } from './contracts';

const text=(v:any)=>String(v??'').trim();
export function opportunityCompanyId(record:any){const company=Array.isArray(record.company)?record.company[0]:record.company;return text(record.company_id??company?.company_id??company?.id);}
export class UncertainWrite extends Error { constructor(public readonly operation: string) { super('write_requires_reconciliation'); } }
export function identityMatch(detail:any, email:string, phone:string) {
  const contacts=detail.customers || detail.customer_list || [];
  const normalize=(v:any)=>text(v).replace(/[\s().-]/g,'');
  const phones=(v:any):string[]=>{
    if (typeof v==='string') return [normalize(v)];
    if (Array.isArray(v)) return v.length===2 && v.every(x=>typeof x==='string') ? [normalize('+'+text(v[0]).replace(/^\+/, '')+v[1]),...v.flatMap(phones)] : v.flatMap(phones);
    if (v && typeof v==='object') return [v.tel,v.phone_number,v.tel_full,v.whatsapp,v.value,...Object.values(v.contact||{}), ...(Array.isArray(v.tel_list)?v.tel_list:[])].flatMap(phones);
    return [];
  };
  return Boolean(email && [detail.main_customer_email,...contacts.map((x:any)=>x.email)].some(x=>text(x).toLowerCase()===email.toLowerCase()) || phone && phones(contacts).includes(normalize(phone)));
}
@Injectable()
export class OkkiWriter {
  private tokenValue=''; private expires=0;
  constructor(private readonly store: InboxRepository) {}
  async token() {
    if (this.tokenValue && this.expires>Date.now()) return this.tokenValue;
    const base=process.env.OKKI_BASE_URL || 'https://api-sandbox.xiaoman.cn';
    const response=await fetch(base+'/v1/oauth2/access_token',{method:'POST',signal:AbortSignal.timeout(20000),redirect:'error',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:process.env.OKKI_CLIENT_ID||'',client_secret:process.env.OKKI_CLIENT_SECRET||'',scope:'lead company opportunity user'})});
    const d:any=await response.json(); if (!response.ok || !d.access_token) throw new Error('okki_auth_failed');
    this.tokenValue=d.access_token;this.expires=Date.now()+Math.max(60,Number(d.expires_in||300)-60)*1000;return this.tokenValue;
  }
  async request(path:string, body?:any) {
    const token=await this.token();
    const response=await fetch((process.env.OKKI_BASE_URL||'https://api-sandbox.xiaoman.cn')+path,{method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(20000),redirect:'error',headers:{Authorization:token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    if(response.status===401){this.expires=0;throw new Error('okki_auth_expired');}
    const d:any=await response.json();if(!response.ok || ![0,200,undefined].includes(d.code)) throw new Error('okki_http_'+response.status+'_code_'+(Number(d.code)||'invalid'));
    return d.data;
  }
  async pages(path:string, query:Record<string,string>={}) {
    const rows:any[]=[];
    for(let page=1;page<=100;page++) {
      const data=await this.request(path+'?'+new URLSearchParams({...query,start_index:String(page),count:'100'}));
      if(!Array.isArray(data?.list))throw new Error('okki_invalid_page');
      rows.push(...data.list);
      if(!data.list.length || (Number.isFinite(Number(data.totalItem)) && rows.length>=Number(data.totalItem)) || (data.totalItem===undefined&&data.list.length<100))return rows;
    }
    throw new Error('okki_scan_incomplete');
  }
  async write(key:string,kind:string,path:string,payload:any,idField:string) {
    if(!config().okkiWrite)throw new Error('okki_write_disabled');
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    // Commit intent before network IO. A lost response never permits another POST.
    const old=await this.store.transaction('write:'+key,async c=>{
      const row=(await c.query('SELECT * FROM inbox_v2_writes WHERE account_id=$1 AND operation_key=$2',[config().accountId,key])).rows[0];
      if(row?.state==='reconciled_absent'&&row.receipt?.operatorConfirmed===true){await c.query("UPDATE inbox_v2_writes SET state='attempting',request_hash=$3,updated_at=now() WHERE account_id=$1 AND operation_key=$2",[config().accountId,key,hash]);return null;}
      if(row){if(row.request_hash!==hash)throw new Error('idempotency_conflict');return row;}
      await c.query(`INSERT INTO inbox_v2_writes(account_id,operation_key,kind,request_hash,state) VALUES($1,$2,$3,$4,'attempting')`,[config().accountId,key,kind,hash]);return null;
    });
    if(old?.remote_id)return old.remote_id as string;
    if(old){
      const observed=await this.reconcile(kind,payload).catch(()=>null);
      if(!observed)throw new UncertainWrite(key);
      await this.store.db.query("UPDATE inbox_v2_writes SET state='confirmed',remote_id=$3,receipt=$4,updated_at=now() WHERE account_id=$1 AND operation_key=$2",[config().accountId,key,observed,{[idField]:observed,reconciled:true}]);return observed;
    }
    try {
      const data=await this.request(path,payload),id=text(data?.[idField]);
      if(!/^\d+$/.test(id))throw new Error('okki_missing_write_receipt');
      await this.store.db.query(`UPDATE inbox_v2_writes SET state='confirmed',remote_id=$3,receipt=$4,updated_at=now() WHERE account_id=$1 AND operation_key=$2`,[config().accountId,key,id,{[idField]:id}]);return id;
    } catch(error) {
      const reason=error instanceof Error&&/^okki_[a-z_0-9]+$/.test(error.message)?error.message:'transport_or_receipt_uncertain';
      await this.store.db.query(`UPDATE inbox_v2_writes SET state='review',receipt=$3,updated_at=now() WHERE account_id=$1 AND operation_key=$2`,[config().accountId,key,{error:reason}]);throw new UncertainWrite(key);
    }
  }
  async reconcile(kind:string,payload:any):Promise<string|null> {
    if(kind==='opportunity'&&/\[AKE Inbox \d+\/\d+\]$/.test(payload.name||'')){
      const rows=await this.pages('/v1/opportunity/list');
      const matches=rows.filter(r=>r.name===payload.name&&opportunityCompanyId(r)===text(payload.company_id)&&Number(r.amount)===Number(payload.amount)&&text(r.currency)===payload.currency&&text(r.flow_id)===text(payload.flow_id));
      return matches.length===1?text(matches[0].opportunity_id):null;
    }
    if(kind==='trail'){
      const target=Object.fromEntries(['company_id','lead_id','opportunity_id'].filter(k=>payload[k]).map(k=>[k,text(payload[k])]));
      const rows=await this.pages('/v1/dynamic/trail/list',target);const matches=rows.filter(r=>text(r.content)===text(payload.content));return matches.length===1?text(matches[0].trail_id):null;
    }
    return null;
  }
  async dictionaries() {
    const [users,flows,fields,company]=await Promise.all([this.request('/v1/user/list'),this.request('/v1/opportunity/fields/selector?field=sales_flow'),this.request('/v1/opportunity/fields'),this.companyDefinition()]);
    // OKKI's published selector does not expose business types in every tenant.
    // The account's existing opportunity records supply confirmed IDs in that case.
    const selector=await this.request('/v1/opportunity/fields/selector?field=business_type');
    const types=Array.isArray(selector)&&selector.length?selector:await this.pages('/v1/opportunity/list');
    const businessTypes=[...new Map(types.filter((t:any)=>t.business_type_id!==undefined||t.busines_type_id!==undefined).map((t:any)=>{const id=text(t.business_type_id??t.busines_type_id);return [id,{id,name:t.business_type_name||('OKKI 业务类型 '+id),source:'official_account_records'}];})).values()];
    return {users:users.filter((u:any)=>Number(u.enable_flag)===1).map((u:any)=>({id:text(u.user_id),name:u.full_name||u.nickname||text(u.user_id)})),flows:flows.filter((f:any)=>Number(f.enable_flag)===1).map((f:any)=>({id:text(f.flow_id),name:f.name})),businessTypes,fields,company};
  }
  async companyDefinition(){
    const [fields,enums]=await Promise.all([this.request('/v1/company/fields'),this.request('/v1/company/companyEnums')]);
    if(!Array.isArray(fields)||!Array.isArray(enums?.biz_type_list)||!Array.isArray(enums?.intention_level_list))throw new Error('okki_company_dictionary_unavailable');
    const options=(rows:any[])=>rows.map(r=>({id:text(r.code),name:text(r.name)}));
    return {requiredFields:fields.filter((f:any)=>Number(f.require)===1&&Number(f.disable_flag)!==1).map((f:any)=>({id:text(f.id),name:text(f.name)})),bizTypes:options(enums.biz_type_list),intentionLevels:options(enums.intention_level_list)};
  }
  async validateCompanyPayload(payload:Record<string,any>){
    const definition=await this.companyDefinition();
    const missing=definition.requiredFields.filter(f=>payload[f.id]===undefined||payload[f.id]===null||payload[f.id]===''||(Array.isArray(payload[f.id])&&!payload[f.id].length));
    if(missing.length)throw new ConflictException('OKKI 客户必填项未补全：'+missing.map(f=>f.name).join('、'));
    if(payload.biz_type!==undefined&&!definition.bizTypes.some(o=>o.id===text(payload.biz_type)))throw new ConflictException('请选择当前 OKKI 客户类型');
    if(payload.intention_level!==undefined&&!definition.intentionLevels.some(o=>o.id===text(payload.intention_level)))throw new ConflictException('请选择当前 OKKI 采购意向');
  }
  async stages(flow:string) {
    const rows=await this.request('/v1/opportunity/fields/selector?field=stage_list&flow_id='+encodeURIComponent(flow));
    return rows.filter((s:any)=>Number(s.enable_flag)===1).map((s:any)=>({id:text(s.stage_id),name:s.name,requiredFields:s.require_field_setting||[]}));
  }
  async validateSelections(input:OpportunityInput) {
    const d=await this.dictionaries(),stages=await this.stages(input.flowId);
    for(const [items,id] of [[d.users,input.ownerId],[d.flows,input.flowId],[d.businessTypes,input.businessTypeId],[stages,input.stageId]] as [any[],string][])
      if(!items.some(x=>x.id===id))throw new Error('okki_dictionary_selection_invalid');
    const required=stages.find((s:any)=>s.id===input.stageId)?.requiredFields||[];
    if(required.includes('account_date')&&!input.closeDate)throw new ConflictException('所选 OKKI 阶段要求预计结束日期；未知时请保留待补全。');
    if(required.includes('exchange_rate')&&!input.exchangeRate)throw new ConflictException('所选 OKKI 阶段要求已确认汇率，请按 OKKI 的原始汇率单位填写。');
  }
  async findConversationOpportunities(cid:number){return (await this.pages('/v1/opportunity/list')).filter(r=>text(r.name).endsWith(`[AKE Inbox ${config().accountId}/${cid}]`));}
  async verifyTrail(id:string,target:Record<string,string>) {
    const rows=await this.pages('/v1/dynamic/trail/list',target);
    if(!rows.some(r=>text(r.trail_id)===id))throw new Error('trail_readback_pending');
  }
  async refresh(group:string) {
    const link=(await this.store.db.query('SELECT * FROM inbox_v2_links WHERE account_id=$1 AND group_key=$2',[config().accountId,group])).rows[0];
    if(!link)return {};
    const snapshot:any={};
    if(link.lead_id)snapshot.lead=await this.request('/v1/lead/info?lead_id='+link.lead_id);
    if(link.company_id)snapshot.company=await this.request('/v1/company/info?company_id='+link.company_id);
    const ids=(await this.store.db.query("SELECT remote_id FROM inbox_v2_writes WHERE account_id=$1 AND kind='opportunity' AND operation_key IN (SELECT 'opportunity:'||v.conversation_id FROM inbox_v2_conversations v JOIN inbox_v2_contacts c USING(account_id,contact_id) WHERE v.account_id=$1 AND c.group_key=$2) AND remote_id IS NOT NULL",[config().accountId,group])).rows;
    snapshot.opportunities=[];for(const row of ids)snapshot.opportunities.push(await this.request('/v1/opportunity/info?opportunity_id='+row.remote_id));
    await this.store.db.query('UPDATE inbox_v2_links SET snapshot=$3,refreshed_at=now() WHERE account_id=$1 AND group_key=$2',[config().accountId,group,this.store.pack(snapshot)]);
    return {refreshed:true,opportunityIds:ids.map(r=>r.remote_id)};
  }
  async findCompany(email:string,phone:string) {
    const found=new Map<string,any>();
    for(const [word,field] of [[email,'customer_list.email'],[phone,'customer_list.tel'],[phone,'customer_list.contact.value']]) {
      if(!word)continue;
      for(const c of await this.pages('/v1/company/query',{word,search_field:field})) {
        const id=text(c.company_id||c.id); if(!id)continue;
        const d=await this.request('/v1/company/info?company_id='+encodeURIComponent(id));
        if(identityMatch(d,email,phone))found.set(id,d);
      }
    }
    if(found.size>1)throw new Error('identity_conflict_select_customer');
    return [...found.entries()][0];
  }
  async syncLead(group:string,cid:number,contact:any,profile:any,channel:'website'|'email'|'whatsapp') {
    const email=text(contact.email).toLowerCase(),phone=/^\+[1-9]\d{6,14}$/.test(text(contact.phone_number))?text(contact.phone_number):'';
    if(!email&&!phone)throw new Error('waiting_identity');
    let link=(await this.store.db.query('SELECT * FROM inbox_v2_links WHERE account_id=$1 AND group_key=$2',[config().accountId,group])).rows[0];
    if(link?.lead_id || link?.company_id)return link;
    const company=await this.findCompany(email,phone);
    if(company&&contact.identityConfirmed===false)throw new Error('identity_confirmation_required');
    let leadId:string|undefined,companyId=company?.[0];
    if(!companyId) {
      const matches=new Map<string,any>();
      for(const archive of ['0','1','2']) {
        for(const row of await this.pages('/v1/lead/list',{archive,...(!phone&&email?{email}:{})})) {
          const id=text(row.lead_id);if(matches.has(id))continue;
          const d=await this.request('/v1/lead/info?lead_id='+encodeURIComponent(id));
          if(identityMatch(d,email,phone))matches.set(id,d);
        }
      }
      if(matches.size>1)throw new Error('identity_conflict_select_lead');
      if(matches.size===1 && contact.identityConfirmed===false)throw new Error('identity_confirmation_required');
      if(matches.size===1) { const [id,d]=[...matches.entries()][0];leadId=id;if(Number(d.company_id)>0)companyId=text(d.company_id); }
      else {
        const fields=profile.fields||{},marker=`AKE-INBOX:${config().accountId}:${cid}`;
        leadId=await this.write('lead:'+group,'lead','/v1/lead/push',{
          name:fields.company||contact.name||`Inbox inquiry ${cid}`,status:1,origin_list:[config().origins[channel]],
          ...(fields.company?{company_name:fields.company}:{}),...(fields.country&&/^[A-Z]{2}$/.test(fields.country)?{country:fields.country}:{}),
          customers:[{name:contact.name||`Inbox contact ${cid}`,main_customer_flag:1,...(email?{email}:{}),...(phone?{tel:phone}:{}),...(channel==='whatsapp'&&phone?{whatsapp:phone}:{})}],
          remark:marker+'\nChannel: '+channel+'\n'+JSON.stringify(fields),
        },'lead_id');
        const d=await this.request('/v1/lead/info?lead_id='+leadId);
        if(text(d.lead_id)!==leadId || !identityMatch(d,email,phone) || !text(d.remark).includes(marker))throw new Error('okki_lead_readback_failed');
      }
    }
    await this.store.db.query(`INSERT INTO inbox_v2_links(account_id,group_key,lead_id,company_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(account_id,group_key) DO UPDATE SET lead_id=COALESCE(inbox_v2_links.lead_id,excluded.lead_id),company_id=COALESCE(inbox_v2_links.company_id,excluded.company_id)`,[config().accountId,group,leadId||null,companyId||null]);
    return (await this.store.db.query('SELECT * FROM inbox_v2_links WHERE account_id=$1 AND group_key=$2',[config().accountId,group])).rows[0];
  }
  async customer(group:string,cid:number,input:Pick<OpportunityInput,'companyId'|'contactIds'|'createCustomer'|'ownerId'>,contact:any) {
    const email=text(contact.email),phone=text(contact.phone_number);
    let companyId=input.companyId,customerIds=input.contactIds;
    if(input.createCustomer) {
      if(!email&&!/^\+[1-9]\d{6,14}$/.test(phone))throw new Error('customer_contact_required');
      const existing=await this.findCompany(email,phone);
      if(existing)companyId=existing[0];
      else {
        const payload={
        name:input.createCustomer.name,user_id:Number(input.ownerId),is_public:0,pool_id:0,serial_id:'INBOX-'+this.store.identity(group).slice(0,16),
        ...(input.createCustomer.country?{country:input.createCustomer.country}:{}),
        ...(input.createCustomer.bizType?{biz_type:input.createCustomer.bizType}:{}),
        ...(input.createCustomer.intentionLevel!==undefined?{intention_level:input.createCustomer.intentionLevel}:{}),
        customers:[{name:input.createCustomer.contactName,main_customer_flag:1,...(email?{email}:{}),...(phone?{tel:phone}:{})}],
        origin_list:[String(config().origins[(await this.store.conversation(cid))!.channel])],
        remark:`Created with sales confirmation from Inbox conversation ${cid}; source lead retained; not an OKKI native conversion.`,
        };
        await this.validateCompanyPayload(payload);
        companyId=await this.write('company:'+group,'company','/v1/company/pushCompanyAndCustomers',payload,'company_id');
      }
    }
    const company=await this.request('/v1/company/info?company_id='+companyId);
    if(text(company.company_id)!==companyId)throw new Error('customer_readback_failed');
    const contacts=company.customers||company.customer_list||[];
    if(!customerIds.length)customerIds=contacts.filter((c:any)=>identityMatch({customers:[c]},email,phone)).map((c:any)=>text(c.customer_id));
    if(!customerIds.length || customerIds.some(id=>!contacts.some((c:any)=>text(c.customer_id)===id)))throw new Error('select_customer_contact');
    await this.store.db.query(`INSERT INTO inbox_v2_links(account_id,group_key,company_id,customer_ids) VALUES($1,$2,$3,$4)
      ON CONFLICT(account_id,group_key) DO UPDATE SET company_id=excluded.company_id,customer_ids=excluded.customer_ids`,[config().accountId,group,companyId,JSON.stringify(customerIds)]);
    return {companyId,customerIds};
  }
  async opportunity(group:string,cid:number,input:OpportunityInput,contact:any) {
    await this.validateSelections(input);
    const {companyId,customerIds}=await this.customer(group,cid,input,contact);
    const id=await this.write('opportunity:'+cid,'opportunity','/v1/opportunity/push',{
      name:input.name.slice(0,160)+` [AKE Inbox ${config().accountId}/${cid}]`,company_id:Number(companyId),customer_id:customerIds.map(Number),handler:[Number(input.ownerId)],main_user:Number(input.ownerId),
      origin_list:[config().origins[(await this.store.conversation(cid))!.channel]],
      busines_type_id:Number(input.businessTypeId),flow_id:Number(input.flowId),stage:Number(input.stageId),amount:String(input.estimatedAmount),currency:input.currency,
      ...(input.closeDate?{account_date:input.closeDate}:{}),...(input.exchangeRate?{exchange_rate:String(input.exchangeRate)}:{}),
    },'opportunity_id');
    const d=await this.request('/v1/opportunity/info?opportunity_id='+id);
    if(text(d.opportunity_id)!==id||opportunityCompanyId(d)!==companyId||Number(d.amount)!==input.estimatedAmount||text(d.currency)!==input.currency||text(d.stage)!==input.stageId||text(d.flow_id)!==input.flowId||text(d.main_user)!==input.ownerId)throw new Error('opportunity_readback_failed');
    const trailId=await this.write('opportunity-requirements:'+cid,'trail','/v1/dynamic/trail/push',{
      opportunity_id:Number(id),remark_type:101,content:`[AKE-INBOX:${config().accountId}:${cid}]\nProject location: ${input.projectLocation}\nProducts: ${input.products.join(', ')}\nEstimated amount: ${input.estimatedAmount} ${input.currency}\nSource lead is retained; linked customer creation is not a native lead conversion.`,
    },'trail_id');
    await this.verifyTrail(trailId,{opportunity_id:id});
    await this.refresh(group);
    return {companyId,customerIds,opportunityId:id,requirementsTrailId:trailId,nativeLeadConverted:false};
  }
}
