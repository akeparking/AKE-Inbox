import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { InboxRepository } from './repository';
import { config, type Actor } from './contracts';

export function secretEquals(a: string, b: string) { const left=Buffer.from(a),right=Buffer.from(b);return !!b && left.length===right.length && timingSafeEqual(left,right); }
@Injectable()
export class Chatwoot {
  constructor(private readonly store: InboxRepository) {}
  async request(path: string, body?: any, method = body === undefined ? 'GET' : 'POST', credentials?: Record<string,string>) {
    const r = await fetch(config().chatwootUrl+path, { method, signal: AbortSignal.timeout(18000), redirect: 'error',
      headers: { 'content-type':'application/json', ...(credentials ? Object.fromEntries(Object.entries(credentials).filter(([k])=>k!=='x-local-session')) : { api_access_token: process.env.CHATWOOT_API_TOKEN || '' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error('chatwoot_http_'+r.status);
    if (credentials) {
      for (const k of ['access-token','client','uid','token-type']) { const v=r.headers.get(k); if(v) credentials[k]=v; }
      // Chatwoot can rotate Devise tokens on every authenticated request.
      await this.store.db.query('UPDATE inbox_v2_sessions SET credentials=$2 WHERE account_id=$1 AND credentials IS NOT NULL AND token_hash=$3',
        [config().accountId,this.store.pack(Object.fromEntries(Object.entries(credentials).filter(([k])=>k!=='x-local-session'))),credentials['x-local-session']||'']);
    }
    return r.json();
  }
  account(path: string, body?: any, method?: string, credentials?: Record<string,string>) {
    return this.request(`/api/v1/accounts/${config().accountId}${path}`,body,method,credentials);
  }
  async reception(cid: number,readOnly=false): Promise<{mode:'human'|'ai';assigneeId:number|null;onlineCount:number}> {
    const result=await this.request('/ake/internal/reception/'+(readOnly?'status':'route'),{conversationId:cid},'POST',{'x-inbox-key':config().internalKey});
    if(!['human','ai'].includes(result.mode)||!Number.isInteger(result.onlineCount)||result.onlineCount<0)throw new Error('invalid_reception_route');
    return result;
  }
  async login(email: string, password: string) {
    if (email.length>254 || password.length>1024) throw new UnauthorizedException();
    const r = await fetch(config().chatwootUrl+'/auth/sign_in', {method:'POST',signal:AbortSignal.timeout(15000),redirect:'error', headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});
    if (!r.ok) throw new UnauthorizedException('Inbox sign-in failed');
    const credentials: Record<string,string> = {};
    for (const k of ['access-token','client','uid','token-type']) { const v=r.headers.get(k); if (v) credentials[k]=v; }
    const data=(await r.json() as any).data;
    const membership=data?.accounts?.find((a:any)=>a.id===config().accountId);
    if (!membership || !credentials['access-token']) throw new ForbiddenException('Account access required');
    const token=randomBytes(32).toString('hex');
    const actor={ userId:data.id, role:membership.role, accountId:config().accountId, credentials };
    await this.store.db.query('INSERT INTO inbox_v2_sessions VALUES($1,$2,$3,$4,$5,now()+interval \'8 hours\')', [createHash('sha256').update(token).digest('hex'),actor.accountId,actor.userId,actor.role,this.store.pack(credentials)]);
    await this.store.audit(String(actor.userId),'session.created','session');
    return { token, userId:actor.userId, role:actor.role, accountId:actor.accountId };
  }
  async actor(token: string): Promise<Actor> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException('Sign in with your Inbox account');
    const row=(await this.store.db.query('SELECT * FROM inbox_v2_sessions WHERE token_hash=$1 AND expires_at>now() AND account_id=$2', [createHash('sha256').update(token).digest('hex'),config().accountId])).rows[0];
    if (!row) throw new UnauthorizedException('Inbox session expired');
    const credentials=this.store.unpack(row.credentials);
    credentials['x-local-session']=row.token_hash;
    // A revoked Chatwoot session or membership must also revoke access here.
    let profile:any;
    try { profile=await this.request('/api/v1/profile',undefined,'GET',credentials); }
    catch { throw new UnauthorizedException('Inbox session is no longer valid'); }
    const membership=profile.accounts?.find((a:any)=>a.id===config().accountId);
    if (profile.id!==Number(row.user_id) || !membership) throw new ForbiddenException();
    return {userId:profile.id,accountId:config().accountId,role:membership.role,credentials};
  }
  async allowed(actor: Actor, cid: number) {
    let c:any;
    try { c=await this.account(`/conversations/${cid}`,undefined,'GET',actor.credentials); }
    catch { throw new ForbiddenException('Conversation access required'); }
    if (Number(c.account_id ?? config().accountId)!==actor.accountId || !config().channels[String(c.inbox_id)] || config().excluded.includes(cid)) throw new ForbiddenException('Conversation is outside the configured inboxes');
    return c;
  }
  async messages(cid: number, credentials?: Record<string,string>, all=false) {
    const messages:any[]=[]; let before='';
    for (let page=0;page<(all?200:1);page++) {
      const d:any=await this.account(`/conversations/${cid}/messages${before?'?before='+before:''}`,undefined,'GET',credentials);
      if (!Array.isArray(d.payload)) throw new Error('invalid_message_page');
      if (!d.payload.length) return messages.sort((a,b)=>a.id-b.id);
      messages.push(...d.payload); const next=String(Math.min(...d.payload.map((m:any)=>Number(m.id))));
      if (next===before) throw new Error('message_pagination_incomplete'); before=next;
      if (!all) return messages.sort((a,b)=>a.id-b.id);
    }
    throw new Error('message_scan_incomplete');
  }
  async send(cid:number,content:string,jobId:string,revision:number) {
    const d:any=await this.account(`/conversations/${cid}/messages`,{content,message_type:'outgoing',private:false,
      content_attributes:{ake_inbox_job:jobId,ake_inbox_revision:revision,ake_inbox_version:'0.2.0'}},'POST',process.env.CHATWOOT_BOT_TOKEN?{api_access_token:process.env.CHATWOOT_BOT_TOKEN}:undefined);
    if (!Number.isSafeInteger(d.id)) throw new Error('send_receipt_missing');
    return d.id as number;
  }
}
