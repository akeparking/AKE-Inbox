import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MetaFeedback, checkMetaTime } from './meta-feedback';
import { InboxRepository } from '../inbox-v2/repository';
import { sendMetaCapi } from '../conversion/meta-capi';
import { loadConfig } from '../config';
import { touch, marketingAttribution } from './contracts';
import { MarketingService } from './service';
import { Pool } from 'pg';
import { MetaAdsAdapter } from '../conversion/adapters';
import { ConversionService } from '../conversion/conversion.service';

const admin: any = { accountId: 1, userId: 7, role: 'administrator', credentials: {} };
const grant: any = { analytics: 'granted', adStorage: 'granted', adUserData: 'granted', adPersonalization: 'denied' };
const prep = (eventName = 'Lead') => ({ eventName, sourceType: 'website', evidence: 'Fictional local acceptance proof', confirmed: true });

describe('Meta event contract and transport', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('captures only observed, consented Meta clicks without assigning them to Google', () => {
    const yes = touch('https://example.invalid/?fbclid=fictional_click&email=secret', '', grant);
    expect(yes.identifiers.fbc).toMatch(/^fb\.1\.\d+\.fictional_click$/);
    expect(yes.pageUrl).not.toContain('fbclid');
    expect(yes.pageUrl).not.toContain('secret');
    expect(marketingAttribution(yes.identifiers).provider).toBe('meta');
    expect(marketingAttribution({ ...yes.identifiers, gclid: 'fictional_google' }).provider).toBe('organic');
    expect(touch('https://example.invalid/?fbclid=fictional', '', { ...grant, adStorage: 'denied' }).identifiers).toEqual({});
  });
  it('rejects stale, future and invalid event time', () => {
    const now = Math.floor(Date.now()/1000);
    for (const time of [now+1, now-604801, NaN]) expect(() => checkMetaTime(time, now)).toThrow();
    expect(() => checkMetaTime(now-100, now)).not.toThrow();
  });
  const config = () => ({ ...loadConfig().meta, datasetId: '123456789012345', accessToken: 'fictional-token', graphVersion: 'v26.0' });
  it('keeps the token out of the URL and distinguishes acceptance from matching', async () => {
    const mock = vi.fn(async () => new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'fixture_trace' })));
    vi.stubGlobal('fetch', mock);
    const receipt = await sendMetaCapi(config(), { data: [{ event_name: 'Lead' }] });
    expect(receipt.receiptStages).toMatchObject({ acceptance: 'accepted', matching: 'unknown', processing: 'unknown' });
    const [url, options] = (mock.mock.calls as any)[0];
    expect(url).not.toContain('token'); expect(options.headers.authorization).toBe('Bearer fictional-token');
    expect(options.redirect).toBe('error');
  });
  it.each([{ events_received: 0, fbtrace_id: 'fixture' }, { events_received: 1 }, {}, { error: { code: 190 } }])('holds incomplete HTTP 200 receipts for review: %j', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(sendMetaCapi(config(), { data: [{}] })).rejects.toMatchObject({ code: 'META_RECEIPT_INCOMPLETE', uncertain: true });
  });
  it('does not copy provider error details or network errors into logs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 190, message: 'fictional-token secret@example.invalid' } }), { status: 400 })));
    await expect(sendMetaCapi(config(), { data: [{}] })).rejects.toMatchObject({ code: 'META_190', message: 'Meta 拒绝了本次回传', uncertain: false });
    vi.stubGlobal('fetch', vi.fn(async () => { throw Error('fictional-token'); }));
    await expect(sendMetaCapi(config(), { data: [{}] })).rejects.toMatchObject({ code: 'META_OUTCOME_UNKNOWN', uncertain: true });
  });
  it.each([{}, { events_received: 0, fbtrace_id: 'fixture' }])('the legacy adapter also rejects incomplete receipts: %j', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(new MetaAdsAdapter({ ...loadConfig(), meta: config() }).send({ data: [{}] }))
      .rejects.toMatchObject({ code: 'META_RECEIPT_INCOMPLETE', uncertain: true, retryable: false });
  });
  it('the legacy adapter keeps ambiguous uploads out of automatic retry and hides provider details', async () => {
    const adapter = new MetaAdsAdapter({ ...loadConfig(), meta: config() });
    vi.stubGlobal('fetch', vi.fn(async () => { throw Error('fictional connection lost after upload'); }));
    await expect(adapter.send({ data: [{}] })).rejects.toMatchObject({ code: 'META_OUTCOME_UNKNOWN', uncertain: true, retryable: false });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 190, message: 'fixture-private-detail' } }), { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    await expect(adapter.send({ data: [{}] })).rejects.toMatchObject({ code: 'META_190', message: 'Meta 拒绝了本次回传' });
    const [url,options] = (fetch.mock.calls as any)[0];
    expect(String(url)).not.toContain('token');expect(options.redirect).toBe('error');expect(options.signal).toBeDefined();
  });
  it('holds legacy Live Meta work already claimed before an upgrade without a network call', async () => {
    const fetch = vi.fn();vi.stubGlobal('fetch', fetch);
    const delivery = { id:'legacy-fixture',provider:'meta',mode:'live' };
    const store:any = { listDeliveries:async()=>[],claimPendingDeliveries:async()=>[delivery],getQualifiedContext:vi.fn(),updateDelivery:vi.fn(async (_id,update)=>update) };
    const result=await new ConversionService(store).processBatch();
    expect(result[0]).toMatchObject({status:'review',providerErrorCode:'META_LEGACY_REVIEW_REQUIRED'});
    expect(store.getQualifiedContext).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
});

describe.skipIf(!process.env.META_FEEDBACK_TEST_DATABASE_URL)('Manual Meta feedback with isolated PostgreSQL', () => {
  let repo: InboxRepository, meta: MetaFeedback, row: any;
  const fetchMock = vi.fn();
  beforeAll(() => {
    Object.assign(process.env, { DATABASE_URL: process.env.META_FEEDBACK_TEST_DATABASE_URL, INBOX_V2_ENABLED: 'true', INBOX_ACCOUNT_ID: '1', FIELD_ENCRYPTION_KEY: '32'.repeat(32), INBOX_INTERNAL_KEY:'fixture-key', CHATWOOT_API_TOKEN:'fixture-token', INBOX_EFFECTIVE_FROM:'2026-01-01T00:00:00Z', META_FEEDBACK_ENABLED: 'true', META_FEEDBACK_MODE: 'mock' });
    repo = new InboxRepository(); meta = new MetaFeedback(repo);
  });
  afterAll(async () => { await repo?.onModuleDestroy(); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
    Object.assign(process.env, { META_FEEDBACK_ENABLED: 'true', META_FEEDBACK_MODE: 'mock', META_DATASET_ID: '123456789012345', META_ACCESS_TOKEN: 'fictional-token', META_TEST_EVENT_CODE: 'TEST_FIXTURE', MARKETING_TEST_MODE: 'false', MARKETING_ENABLED:'true',ATTRIBUTION_UI_ENABLED:'true',ATTRIBUTION_CAPTURE_ENABLED:'true' });
    await repo.db.query('TRUNCATE marketing_sites,workspaces,inbox_v2_audit CASCADE');
    await repo.db.query('TRUNCATE marketing_meta_legacy_receipts');
    await repo.db.query("INSERT INTO workspaces(id,name) VALUES('fixture','Fixture')");
    await repo.db.query("INSERT INTO leads(id,workspace_id,provider,source_kind,display_name,is_test) VALUES('lead-fixture','fixture','meta','website','Fictional',false)");
    await repo.db.query("INSERT INTO marketing_sites(id,account_id,name,origin,inbox_id,enabled) VALUES('fixture',1,'Fixture','https://example.invalid',1,true)");
    const consent = randomUUID(), visitor = randomUUID(), visit = randomUUID(), inquiry = randomUUID();
    await repo.db.query("INSERT INTO marketing_consents(id,site_id,choices,policy_version) VALUES($1,'fixture',$2,'fixture')", [consent, grant]);
    await repo.db.query("INSERT INTO marketing_visitors(id,site_id,first_touch,consent_id) VALUES($1,'fixture','{}',$2)", [visitor, consent]);
    await repo.db.query("INSERT INTO marketing_visits(id,visitor_id,site_id,current_touch) VALUES($1,$2,'fixture',$3)", [visit, visitor, { pageUrl: 'https://example.invalid/product', identifiersCipher: repo.pack({ fbc: 'fb.1.1234567890000.fictional_click' }),browserCipher:repo.pack({userAgent:'Fictional browser acceptance fixture'}) }]);
    const payload = repo.pack({ definition: { fields: [{ key: 'email', mapping: 'email' }, { key: 'phone', mapping: 'phone' }] }, fields: { email: 'QA@Example.Invalid', phone: '+1 (555) 555-0123' } });
    row = (await repo.db.query("INSERT INTO marketing_inquiries(id,site_id,account_id,source_submission_id,source_kind,request_hash,payload,visitor_id,visit_id,consent_id,lead_id,message_id,created_at,qualified_at) VALUES($1::uuid,'fixture',1,$1::text,'form','fixture',$2,$3,$4,$5,'lead-fixture',1,now()-interval '10 minutes',now()-interval '5 minutes') RETURNING *", [inquiry, payload, visitor, visit, consent])).rows[0];
  });
  afterEach(() => vi.unstubAllGlobals());
  const ready = (eventName = 'Lead', extra: any = {}) => meta.prepare(admin, row, { ...prep(eventName), ...extra });
  it('supports website Lead and manual Qualified, with no network calls in Mock', async () => {
    const lead = await ready(), q = await ready('QualifiedLead');
    await expect(meta.send(admin, row, q.id)).rejects.toThrow('此前阶段');
    expect((await meta.send(admin, row, lead.id)).status).toBe('mock');
    expect((await meta.send(admin, row, q.id)).status).toBe('mock');
    const converted=await ready('ConvertedLead',{occurredAt:new Date().toISOString()});
    expect((await meta.send(admin,row,converted.id)).status).toBe('mock');
    expect(fetchMock).not.toHaveBeenCalled();
    const events = (await repo.db.query('SELECT payload FROM marketing_meta_feedback ORDER BY occurred_at')).rows.map(r => repo.unpack(r.payload).data[0]);
    expect(events[0]).toMatchObject({ action_source: 'website', event_source_url: 'https://example.invalid/product' });
    expect(events[0].user_data.client_user_agent).toBe('Fictional browser acceptance fixture');
    expect(events[1].action_source).toBe('other'); expect(events[1].custom_data.event_source).toBeUndefined();
    expect(events[0].user_data.em[0]).toHaveLength(64); expect(JSON.stringify(events)).not.toContain('QA@');
    expect(events[0].event_id).not.toBe(events[1].event_id);
    const publicRows = await meta.rows(1);
    expect(JSON.stringify(publicRows)).not.toContain('fictional_click'); expect(publicRows[0]).not.toHaveProperty('payload');
  });
  it('serializes concurrent clicks and survives service re-creation without duplicate sends', async () => {
    process.env.META_FEEDBACK_MODE = 'test';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'trace_once' })));
    const a = await ready(), b = await ready(); expect(b).toEqual({ id: a.id, duplicate: true });
    const results = await Promise.all([meta.send(admin, row, a.id), meta.send(admin, row, a.id)]);
    expect(results.filter(r => r.duplicate)).toHaveLength(1); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await new MetaFeedback(repo).send(admin, row, a.id)).duplicate).toBe(true);
    expect((await repo.db.query('SELECT count(*)::int n FROM marketing_meta_attempts')).rows[0].n).toBe(1);
    const sent = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(sent.test_event_code).toBe('TEST_FIXTURE');
  });
  it('completes six simultaneous sends at the connection-pool limit with one upload', async () => {
    process.env.META_FEEDBACK_MODE='test';
    fetchMock.mockImplementation(async()=>new Response(JSON.stringify({events_received:1,fbtrace_id:'pool_fixture'})));
    const a=await ready(),clients=await Promise.all(Array.from({length:6},()=>repo.db.connect()));
    const pids=await Promise.all(clients.map(async c=>(await c.query('SELECT pg_backend_pid() pid')).rows[0].pid));
    clients.forEach(c=>c.release());
    const requests=Array.from({length:6},()=>meta.send(admin,row,a.id));
    const all=Promise.all(requests);let finished=false,timer:NodeJS.Timeout|undefined;
    try {
      const results=await Promise.race([all,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('pool did not make progress')),3000);})]);
      finished=true;expect(results.filter(r=>!r.duplicate)).toHaveLength(1);expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      if(timer)clearTimeout(timer);
      if(!finished){
        // Only terminate connections captured from this test's isolated pool, so a regression fails promptly.
        const observer=new Pool({connectionString:process.env.META_FEEDBACK_TEST_DATABASE_URL});
        await observer.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=ANY($1::int[])',[pids]);
        await observer.end();await Promise.allSettled(requests);
      }
    }
    expect((await repo.db.query('SELECT 1 AS responsive')).rows[0].responsive).toBe(1);
  });
  it('uses native CRM fields and deduplicates one Meta Lead ID across inquiries', async () => {
    const b = { sourceType: 'instant_form', metaLeadId: '1234567890123456', leadGeneratedAt: new Date(Date.now()-7200000).toISOString(), consentConfirmed: true };
    const a = await ready('Lead', b);
    const event = repo.unpack((await repo.db.query('SELECT payload FROM marketing_meta_feedback WHERE id=$1', [a.id])).rows[0].payload).data[0];
    expect(event).toMatchObject({ action_source: 'system_generated', custom_data: { event_source: 'crm' }, user_data: { lead_id: b.metaLeadId } });
    expect(event.event_time).toBe(Math.floor(new Date(b.leadGeneratedAt).getTime()/1000));
    expect(event.event_time).not.toBe(Math.floor(new Date(row.created_at).getTime()/1000));
    await expect(meta.prepare(admin, { ...row, id: randomUUID() }, { ...prep(), ...b })).rejects.toThrow('其他询盘');
    await expect(ready('QualifiedLead', { ...b, metaLeadId: '1234567890123457' })).rejects.toThrow('其他来源');
  });
  it('checks role, account and inquiry scope on both preparation and sending', async () => {
    await expect(meta.prepare({ ...admin, role: 'agent' }, row, prep())).rejects.toThrow();
    await expect(meta.prepare({ ...admin, accountId: 2 }, row, prep())).rejects.toThrow();
    const a = await ready();
    await expect(meta.send({ ...admin, role: 'agent' }, row, a.id)).rejects.toThrow();
    await expect(meta.send(admin, { ...row, id: randomUUID() }, a.id)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rechecks consent and attribution corrections just before dispatch', async () => {
    const a = await ready();
    await repo.db.query('UPDATE marketing_inquiries SET visit_id=NULL WHERE id=$1',[row.id]);
    await expect(meta.send(admin, row, a.id)).rejects.toThrow('来源关联');
    await repo.db.query('UPDATE marketing_inquiries SET visit_id=$2 WHERE id=$1',[row.id,row.visit_id]);
    await repo.db.query('UPDATE marketing_visitors SET revoked_at=now() WHERE id=$1', [row.visitor_id]);
    await expect(meta.send(admin, row, a.id)).rejects.toThrow('撤回'); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('invalidates a ready event when correction commits while native permissions are pending', async () => {
    process.env.META_FEEDBACK_MODE='test';
    await repo.db.query('UPDATE marketing_inquiries SET conversation_id=101 WHERE id=$1',[row.id]);
    const a=await ready();let unblock!:()=>void,loaded!:()=>void,calls=0;
    const gate=new Promise<void>(r=>unblock=r),read=new Promise<void>(r=>loaded=r);
    const cw:any={allowed:async()=>{if(++calls===1){loaded();await gate;}}};
    const service=new MarketingService(repo,cw,{} as any,{} as any);
    const sending=service.action(admin,'meta_send',{inquiryId:row.id,feedbackId:a.id});await read;
    try { await service.action(admin,'correct_link',{id:row.id,visitorId:null,visitId:null,expectedRevision:row.revision,requestId:randomUUID(),reason:'Fictional wrong visitor association',evidenceRefs:['fixture:correction']}); }
    finally { unblock(); }
    expect(await sending).toMatchObject({duplicate:true,status:'review'});expect(fetchMock).not.toHaveBeenCalled();
    expect((await repo.db.query('SELECT error_code FROM marketing_meta_feedback WHERE id=$1',[a.id])).rows[0].error_code).toBe('ATTRIBUTION_CHANGED');
  });
  it('does not let a source correction commit during an already-claimed upload', async () => {
    process.env.META_FEEDBACK_MODE='test';const a=await ready();let sent!:()=>void,finish!:()=>void;
    const started=new Promise<void>(r=>sent=r),gate=new Promise<void>(r=>finish=r);
    fetchMock.mockImplementation(async()=>{sent();await gate;return new Response(JSON.stringify({events_received:1,fbtrace_id:'inflight_fixture'}));});
    const sending=meta.send(admin,row,a.id);await started;
    try {
      const service=new MarketingService(repo,{} as any,{} as any,{} as any);
      await expect(service.action(admin,'correct_link',{id:row.id,visitorId:null,expectedRevision:row.revision,requestId:randomUUID(),reason:'Fictional in-flight source correction',evidenceRefs:['fixture:correction']})).rejects.toThrow('正在发送');
      expect((await repo.db.query('SELECT visitor_id FROM marketing_inquiries WHERE id=$1',[row.id])).rows[0].visitor_id).toBe(row.visitor_id);
    } finally { finish();await sending; }
  });
  it.each([['test','accepted',0],['live','accepted',1],['test','dead_letter',5],['test','skipped',1]])('blocks legacy %s / %s work with %s prior attempts', async (mode,status,attempts) => {
    process.env.META_FEEDBACK_MODE=String(mode);fetchMock.mockImplementation(async()=>new Response(JSON.stringify({events_received:1,fbtrace_id:'legacy_fixture'})));
    const lead=await ready();await meta.send(admin,row,lead.id);fetchMock.mockClear();
    await repo.db.query("INSERT INTO conversion_events(id,workspace_id,event_key,event_type,primary_source_lead_id,attribution_snapshot,occurred_at) VALUES('old-event','fixture','old-event','LeadQualified','lead-fixture','{}',now()-interval '5 minutes')");
    await repo.db.query("INSERT INTO conversion_deliveries(id,workspace_id,conversion_event_id,event_key,event_type,provider,primary_source_lead_id,status,occurred_at,mode) VALUES('old-delivery','fixture','old-event','old-event','LeadQualified','meta','lead-fixture','accepted',now()-interval '5 minutes','live')");
    await repo.db.query('UPDATE conversion_deliveries SET status=$1,attempt_count=$2 WHERE id=$3',[status,attempts,'old-delivery']);
    const q=await ready('QualifiedLead');await expect(meta.send(admin,row,q.id)).rejects.toThrow('旧回传账本');expect(fetchMock).not.toHaveBeenCalled();
  });
  it('records newly consented browser context in a new visit without changing prior consent', async () => {
    const service=new MarketingService(repo,{} as any,{} as any,{} as any);
    const input={siteId:'fixture',pageUrl:'https://example.invalid/product?fbclid=fictional_new_click',consent:{...grant,adStorage:'denied',adUserData:'denied'},policyVersion:'fixture'};
    const denied=await service.session(input,'https://example.invalid','Fictional browser');
    const deniedClaims=await service.claims(denied.sessionToken,'fixture');
    const oldRow=(await repo.db.query('UPDATE marketing_inquiries SET visitor_id=$2,visit_id=$3,consent_id=$4 WHERE id=$1 RETURNING *',[row.id,denied.visitorId,denied.visitId,deniedClaims.consentId])).rows[0];
    const allowed=await service.session({...input,consent:grant,visitorToken:denied.visitorToken!,visitToken:denied.visitToken!},'https://example.invalid','Fictional browser');
    expect(allowed.visitorId).toBe(denied.visitorId);expect(allowed.visitId).not.toBe(denied.visitId);
    expect((await repo.db.query('SELECT current_touch FROM marketing_visits WHERE id=$1',[denied.visitId])).rows[0].current_touch.browserCipher).toBeNull();
    await expect(meta.prepare(admin,oldRow,prep())).rejects.toThrow('同意');
    const claims=await service.claims(allowed.sessionToken,'fixture'),id=randomUUID();
    const next=(await repo.db.query("INSERT INTO marketing_inquiries(id,site_id,account_id,source_submission_id,source_kind,request_hash,payload,visitor_id,visit_id,consent_id,lead_id,message_id) VALUES($1::uuid,'fixture',1,$1::text,'form','fixture',$2,$3,$4,$5,'lead-fixture',2) RETURNING *",[id,row.payload,allowed.visitorId,allowed.visitId,claims.consentId])).rows[0];
    const a=await meta.prepare(admin,next,prep());
    const payload=repo.unpack((await repo.db.query('SELECT payload FROM marketing_meta_feedback WHERE id=$1',[a.id])).rows[0].payload);
    expect(payload.data[0].user_data.client_user_agent).toBe('Fictional browser');expect(payload.data[0].user_data.fbc).toContain('fictional_new_click');
    const again=await service.session({...input,consent:grant,visitorToken:allowed.visitorToken!,visitToken:allowed.visitToken!},'https://example.invalid','Fictional browser');
    expect(again.visitId).toBe(allowed.visitId);expect(fetchMock).not.toHaveBeenCalled();
    const staleTab=await service.session({...input,consent:grant,visitorToken:denied.visitorToken!,visitToken:denied.visitToken!},'https://example.invalid','Fictional second tab');
    expect(staleTab.visitId).not.toBe(denied.visitId);
    expect(repo.unpack((await repo.db.query('SELECT current_touch FROM marketing_visits WHERE id=$1',[staleTab.visitId])).rows[0].current_touch.browserCipher).userAgent).toBe('Fictional second tab');
  });
  it('blocks missing consent, stale events, fake native IDs and future conversion time', async () => {
    await expect(meta.prepare(admin, { ...row, created_at: new Date(Date.now()-8*86400000) }, prep())).rejects.toThrow('7 天');
    await expect(ready('Lead', { sourceType: 'instant_form', metaLeadId: '123' })).rejects.toThrow();
    await expect(ready('Lead', { sourceType: 'instant_form', metaLeadId: '1234567890123456', leadGeneratedAt: new Date(Date.now()-8*86400000).toISOString(), consentConfirmed: true })).rejects.toThrow('7 天');
    await expect(ready('ConvertedLead', { occurredAt: new Date(Date.now()+86400000).toISOString() })).rejects.toThrow('7 天');
    await repo.db.query("UPDATE marketing_consents SET choices='{}' WHERE id=$1", [row.consent_id]);
    await expect(ready()).rejects.toThrow('同意');
  });
  it('does not invent missing browser context for a website Lead', async () => {
    await repo.db.query("UPDATE marketing_visits SET current_touch=current_touch-'browserCipher' WHERE id=$1",[row.visit_id]);
    await expect(ready()).rejects.toThrow('原始浏览器信息');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('holds uncertain outcomes without replaying them or inventing matching', async () => {
    process.env.META_FEEDBACK_MODE = 'test'; fetchMock.mockRejectedValue(Error('timeout'));
    const a = await ready(); expect((await meta.send(admin, row, a.id)).status).toBe('review');
    expect((await meta.send(admin, row, a.id)).duplicate).toBe(true); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await meta.rows(1))[0]).toMatchObject({ status: 'review', matching: 'unknown' });
  });
  it('retries only rejected events with the original time and ID', async () => {
    process.env.META_FEEDBACK_MODE = 'test';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 190 } }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'trace_retry' })));
    const a = await ready(); expect((await meta.send(admin, row, a.id)).status).toBe('rejected');
    expect((await meta.send(admin, row, a.id)).status).toBe('test');
    expect((fetchMock.mock.calls[0] as any)[1].body).toBe((fetchMock.mock.calls[1] as any)[1].body);
  });
  it('pins dataset and mode, and blocks test records in live mode', async () => {
    const a = await ready(); process.env.META_FEEDBACK_MODE = 'live';
    await expect(meta.send(admin, row, a.id)).rejects.toThrow('配置');
    await repo.db.query("UPDATE leads SET is_test=true WHERE id='lead-fixture'");
    await expect(ready()).rejects.toThrow('测试询盘');
    process.env.META_FEEDBACK_MODE = 'test';
    await expect(ready()).rejects.toThrow('Test Events');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('recovers an interrupted claim to review without a new upload', async () => {
    const a = await ready();
    await repo.db.query("UPDATE marketing_meta_feedback SET status='sending',updated_at=now()-interval '3 minutes' WHERE id=$1", [a.id]);
    expect((await meta.rows(1))[0].status).toBe('review');
    expect((await meta.send(admin, row, a.id)).duplicate).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('requires actual qualification and keeps initial stage time frozen', async () => {
    await expect(meta.prepare(admin, { ...row, qualified_at: null }, prep('QualifiedLead'))).rejects.toThrow('人工确认');
    const a = await ready();
    const event = repo.unpack((await repo.db.query('SELECT payload FROM marketing_meta_feedback WHERE id=$1', [a.id])).rows[0].payload).data[0];
    expect(event.event_time).toBe(Math.floor(new Date(row.created_at).getTime()/1000));
  });
  it('never uploads an accepted Test Event again after switching to Live', async () => {
    process.env.META_FEEDBACK_MODE = 'test';
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'trace_test_live' })));
    const a = await ready(); await meta.send(admin,row,a.id);
    process.env.META_FEEDBACK_MODE = 'live';
    await expect(ready()).rejects.toThrow('已有 Meta 发送记录');
    const q = await ready('QualifiedLead');
    expect((await meta.send(admin,row,q.id)).status).toBe('accepted');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchMock.mock.calls[1] as any)[1].body).test_event_code).toBeUndefined();
  });
  it('rechecks cross-mode claims prepared before another mode sends', async () => {
    process.env.META_FEEDBACK_MODE = 'test'; const test = await ready();
    process.env.META_FEEDBACK_MODE = 'live'; const live = await ready();
    process.env.META_FEEDBACK_MODE = 'test'; fetchMock.mockRejectedValue(Error('response lost'));
    expect((await meta.send(admin,row,test.id)).status).toBe('review');
    process.env.META_FEEDBACK_MODE = 'live';
    await expect(meta.send(admin,row,live.id)).rejects.toThrow('已有 Meta 发送记录');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('honors imported receipts but never treats a mistaken qualification as a valid stage', async () => {
    process.env.META_FEEDBACK_MODE = 'test';
    const b = { sourceType:'instant_form',metaLeadId:'1234567890123456',leadGeneratedAt:new Date(Date.now()-7200000).toISOString(),consentConfirmed:true };
    const subject = repo.identity('instant_form:'+b.metaLeadId);
    for (const [name,status,time] of [['Lead','accepted',row.created_at],['QualifiedLead','sent_in_error',row.qualified_at]]) {
      await repo.db.query('INSERT INTO marketing_meta_legacy_receipts(id,account_id,dataset_id,subject_key,event_name,event_id,occurred_at,status,evidence) VALUES($1,1,$2,$3,$4,$1,$5,$6,$7)',
        ['legacy:'+name,process.env.META_DATASET_ID,subject,name,time,status,repo.pack({source:'fictional audited ledger'})]);
    }
    await expect(ready('Lead',b)).rejects.toThrow('已有 Meta 发送记录');
    await expect(ready('QualifiedLead',b)).rejects.toThrow('已有 Meta 发送记录');
    const converted = await ready('ConvertedLead',{...b,occurredAt:new Date().toISOString()});
    await expect(meta.send(admin,row,converted.id)).rejects.toThrow('此前阶段');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
