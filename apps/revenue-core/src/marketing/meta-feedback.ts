import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { InboxRepository } from '../inbox-v2/repository';
import type { Actor } from '../inbox-v2/contracts';
import { loadConfig } from '../config';
import { AdapterError } from '../conversion/adapters';
import { sendMetaCapi } from '../conversion/meta-capi';
import type { Pool, PoolClient } from 'pg';

const stages = ['Lead', 'QualifiedLead', 'ConvertedLead'] as const;
const prepareSchema = z.object({
  eventName: z.enum(stages), sourceType: z.enum(['website', 'instant_form']),
  metaLeadId: z.string().regex(/^\d{15,17}$/).optional(), leadGeneratedAt: z.iso.datetime().optional(),
  occurredAt: z.iso.datetime().optional(), evidence: z.string().trim().min(8).max(1000),
  confirmed: z.literal(true), consentConfirmed: z.literal(true).optional(),
});
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const unix = (v: any) => Math.floor(new Date(v).getTime() / 1000);
export function checkMetaTime(eventTime: number, now = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(eventTime) || eventTime > now || eventTime < now - 7 * 86400) {
    throw new BadRequestException('仅能回传真实发生时间在最近 7 天内的阶段；不能改写时间补传');
  }
}

export class MetaFeedback {
  constructor(private readonly repo: InboxRepository) {}
  settings() {
    const config = loadConfig().meta;
    const mode = process.env.META_FEEDBACK_MODE || 'mock';
    if (!['mock', 'test', 'live'].includes(mode)) throw new ServiceUnavailableException('Meta 回传模式无效');
    const enabled = process.env.META_FEEDBACK_ENABLED === 'true';
    const configured = !!config.accessToken && /^\d{5,30}$/.test(config.datasetId || '') && /^v\d+\.0$/.test(config.graphVersion);
    return { enabled, mode, datasetId: config.datasetId || (mode === 'mock' ? 'mock-dataset' : ''), testCodeConfigured: !!process.env.META_TEST_EVENT_CODE,
      configured, canSend: enabled && (mode === 'mock' || (configured && (mode !== 'test' || !!process.env.META_TEST_EVENT_CODE))),
      testCode: mode === 'test' ? process.env.META_TEST_EVENT_CODE : undefined };
  }
  publicSettings() { const { testCode, ...safe } = this.settings(); return safe; }
  private admin(actor: Actor) { if (actor.role !== 'administrator') throw new ForbiddenException('Meta 回传需要管理员权限'); }
  private enabled() { if (!this.settings().enabled) throw new ServiceUnavailableException('Meta Ads 回传尚未启用'); }
  private async alreadyDispatched(db: any, datasetId: string, subjectKey: string, eventName: string, exceptId?: string) {
    const prior = await db.query(`SELECT 1 FROM marketing_meta_feedback WHERE dataset_id=$1 AND subject_key=$2 AND event_name=$3
      AND mode IN ('test','live') AND status IN ('sending','test','accepted','review') AND ($4::uuid IS NULL OR id<>$4)
      UNION ALL SELECT 1 FROM marketing_meta_legacy_receipts WHERE dataset_id=$1 AND subject_key=$2 AND event_name=$3 LIMIT 1`,
      [datasetId,subjectKey,eventName,exceptId || null]);
    if (prior.rows.length) throw new ConflictException('该阶段已有 Meta 发送记录（含测试或旧网关），不能重复回传；结果未知时须先核对');
  }
  async rows(accountId: number, inquiryId?: string) {
    // A crashed process never converts an ambiguous upload into a fresh upload.
    await this.repo.db.query("UPDATE marketing_meta_feedback SET status='review',error_code='META_INTERRUPTED',updated_at=now() WHERE account_id=$1 AND status='sending' AND updated_at<now()-interval '2 minutes'", [accountId]);
    return (await this.repo.db.query(`SELECT id,inquiry_id,source_type,mode,dataset_id,event_name,event_id,occurred_at,status,
      attempt_count,response_id,error_code,created_at,updated_at FROM marketing_meta_feedback
      WHERE account_id=$1 AND ($2::uuid IS NULL OR inquiry_id=$2) ORDER BY created_at DESC LIMIT 200`, [accountId, inquiryId || null])).rows
      .map(r => ({ ...r, matching: 'unknown', processing: 'unknown' }));
  }
  private async eligibility(row: any, sourceType: string, mode: string, db: Pool | PoolClient = this.repo.db) {
    if (!row.message_id || !row.lead_id || row.identity_state === 'conflict') throw new ConflictException('等待 Inbox 收件，并先解决身份冲突');
    if (row.contact_id) {
      const c = (await db.query('SELECT identity_conflict,opted_out,blocked FROM inbox_v2_contacts WHERE account_id=$1 AND contact_id=$2', [row.account_id, row.contact_id])).rows[0];
      if (c?.identity_conflict || c?.opted_out || c?.blocked) throw new ConflictException('联系人存在身份冲突、退订或屏蔽');
    }
    const lead = (await db.query('SELECT is_test FROM leads WHERE id=$1', [row.lead_id])).rows[0];
    if (mode !== 'mock' && lead?.is_test !== false) throw new ConflictException('虚构测试询盘不能发送至 Meta，包括 Test Events');
    if (mode === 'live' && process.env.MARKETING_TEST_MODE === 'true') throw new ConflictException('本地测试环境尚未启用正式回传');
    if (sourceType === 'website') {
      if (!['form', 'website', 'backend_form'].includes(row.source_kind)) throw new ConflictException('该询盘不是网站收件');
      const consent = (await db.query('SELECT choices FROM marketing_consents WHERE id=$1 AND site_id=$2', [row.consent_id, row.site_id])).rows[0]?.choices;
      if (consent?.adStorage !== 'granted' || consent?.adUserData !== 'granted') throw new ConflictException('缺少广告数据使用同意');
      if (row.visitor_id) {
        const visitor = (await db.query('SELECT v.revoked_at,c.choices FROM marketing_visitors v JOIN marketing_consents c ON c.id=v.consent_id WHERE v.id=$1 AND v.site_id=$2', [row.visitor_id, row.site_id])).rows[0];
        if (!visitor || visitor.revoked_at || visitor.choices.adStorage !== 'granted' || visitor.choices.adUserData !== 'granted') throw new ConflictException('广告数据使用同意已撤回');
      }
    }
  }
  async prepare(actor: Actor, row: any, input: unknown) {
    this.admin(actor); this.enabled();
    if (actor.accountId !== Number(row.account_id)) throw new ForbiddenException();
    const b = prepareSchema.parse(input), settings = this.settings();
    await this.eligibility(row, b.sourceType, settings.mode);
    // A historical form imported today keeps Meta's actual submission time.
    const time = b.eventName === 'Lead' ? unix(b.sourceType === 'instant_form' ? b.leadGeneratedAt : row.created_at)
      : b.eventName === 'QualifiedLead' ? unix(row.qualified_at) : unix(b.occurredAt);
    if (b.eventName === 'QualifiedLead' && !row.qualified_at) throw new ConflictException('先人工确认有效线索');
    if (b.eventName === 'ConvertedLead' && (!row.qualified_at || !b.occurredAt || time < unix(row.qualified_at))) throw new ConflictException('成交阶段需要真实时间及已确认有效的询盘');
    checkMetaTime(time);
    const userData: Record<string, any> = {};
    let subject: string, sourceUrl: string | undefined;
    if (b.sourceType === 'instant_form') {
      if (!b.metaLeadId || !b.leadGeneratedAt || !b.consentConfirmed || unix(b.leadGeneratedAt) > time) throw new BadRequestException('需要核验 Meta 原生表单 Lead ID、生成时间及数据使用依据');
      userData.lead_id = b.metaLeadId; subject = 'instant_form:' + b.metaLeadId;
    } else {
      if (b.metaLeadId || b.leadGeneratedAt) throw new BadRequestException('网站询盘不能使用原生表单 Lead ID');
      subject = 'website:' + row.id;
      const visit = row.visit_id ? (await this.repo.db.query('SELECT current_touch FROM marketing_visits WHERE id=$1 AND site_id=$2', [row.visit_id, row.site_id])).rows[0]?.current_touch : null;
      const ids = this.repo.unpack(visit?.identifiersCipher) || {};
      if (ids.fbc) userData.fbc = ids.fbc;
      const data = this.repo.unpack(row.payload), fields = data?.fields || {};
      for (const field of data?.definition?.fields || []) {
        const value = String(fields[field.key] || '').trim();
        if (field.mapping === 'email' && z.email().safeParse(value).success) userData.em = [digest(value.toLowerCase())];
        if (field.mapping === 'phone' && /^\+[1-9]\d{6,14}$/.test(value.replace(/[ ()-]/g, ''))) userData.ph = [digest(value.replace(/\D/g, ''))];
      }
      if (!Object.keys(userData).length) throw new ConflictException('缺少可匹配的 Meta 点击标识或已获同意的联系方式');
      sourceUrl = visit?.pageUrl;
      if (b.eventName === 'Lead' && !sourceUrl) throw new ConflictException('网站 Lead 缺少原始来源网址');
      if (b.eventName === 'Lead') {
        const browser = this.repo.unpack(visit?.browserCipher);
        if (!browser?.userAgent) throw new ConflictException('网站 Lead 缺少原始浏览器信息，不能使用服务器信息代替');
        userData.client_user_agent = browser.userAgent;
      }
    }
    const subjectKey = this.repo.identity(subject), eventId = b.sourceType==='website'&&b.eventName==='Lead'
      ? 'inbox:website:lead:'+row.id
      : 'inbox:meta:' + digest(actor.accountId + ':' + subjectKey + ':' + b.eventName).slice(0,40);
    const event: Record<string, any> = { event_name: b.eventName, event_time: time, event_id: eventId,
      action_source: b.sourceType === 'instant_form' ? 'system_generated' : b.eventName === 'Lead' ? 'website' : 'other', user_data: userData,
      ...(b.sourceType === 'website' && b.eventName === 'Lead' ? { event_source_url: sourceUrl } : {}),
      custom_data: b.sourceType === 'instant_form' ? { event_source: 'crm', lead_event_source: loadConfig().meta.leadEventSource } : { lead_stage: b.eventName },
    };
    const payload = { data: [event], ...(settings.testCode ? { test_event_code: settings.testCode } : {}) };
    return this.repo.transaction('meta-prepare:' + actor.accountId, async db => {
      const old = (await db.query('SELECT * FROM marketing_meta_feedback WHERE account_id=$1 AND dataset_id=$2 AND mode=$3 AND subject_key=$4 AND event_name=$5', [actor.accountId, settings.datasetId, settings.mode, subjectKey, b.eventName])).rows[0];
      if (old) {
        if (old.inquiry_id !== row.id) throw new ConflictException('该 Meta 线索阶段已在其他询盘登记，请核对原回执');
        return { id: old.id, duplicate: true };
      }
      if (settings.mode !== 'mock') await this.alreadyDispatched(db, settings.datasetId, subjectKey, b.eventName);
      const bound = (await db.query('SELECT subject_key,source_type FROM marketing_meta_feedback WHERE account_id=$1 AND inquiry_id=$2 LIMIT 1', [actor.accountId, row.id])).rows[0];
      if (bound && (bound.subject_key !== subjectKey || bound.source_type !== b.sourceType)) throw new ConflictException('询盘已绑定其他来源，不能改号后重新回传');
      const id = randomUUID();
      await db.query(`INSERT INTO marketing_meta_feedback(id,account_id,inquiry_id,subject_key,source_type,mode,dataset_id,event_name,event_id,occurred_at,payload,actor_id,evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10),$11,$12,$13)`, [id, actor.accountId, row.id, subjectKey, b.sourceType, settings.mode, settings.datasetId, b.eventName, eventId, time, this.repo.pack(payload), actor.userId, this.repo.pack({ evidence: b.evidence, leadGeneratedAt: b.leadGeneratedAt, consentConfirmed: b.consentConfirmed, attributionKey:this.repo.identity(JSON.stringify([row.visitor_id,row.visit_id,row.consent_id])) })]);
      await this.repo.audit(String(actor.userId), 'meta.prepared', id, { eventName: b.eventName, mode: settings.mode }, db);
      return { id, duplicate: false };
    });
  }
  async send(actor: Actor, inquiry: any, id: string) {
    this.admin(actor); this.enabled(); z.uuid().parse(id);
    if (actor.accountId !== Number(inquiry.account_id)) throw new ForbiddenException();
    // Test Events also reach Meta measurement. Serialize claims across modes/senders.
    const claim = await this.repo.transaction('meta-outbound', async db => {
      // The inquiry is authoritative; the caller may have waited for native permissions.
      // Lock it before feedback rows, matching the order used by source corrections.
      const latest = (await db.query('SELECT * FROM marketing_inquiries WHERE id=$1 AND account_id=$2 FOR UPDATE', [inquiry.id, actor.accountId])).rows[0];
      if (!latest) throw new ForbiddenException('询盘不可用');
      const row = (await db.query('SELECT * FROM marketing_meta_feedback WHERE id=$1 AND account_id=$2 AND inquiry_id=$3 FOR UPDATE', [id, actor.accountId, inquiry.id])).rows[0];
      if (!row) throw new ForbiddenException('回执不属于此询盘');
      if (row.status !== 'ready' && row.status !== 'rejected') return { duplicate: true, status: row.status };
      const settings = this.settings();
      if (!settings.canSend || row.mode !== settings.mode || row.dataset_id !== settings.datasetId) throw new ConflictException('回传配置已改变或尚未完成，请核对模式与数据集');
      if (row.mode !== 'mock') await this.alreadyDispatched(db, row.dataset_id, row.subject_key, row.event_name, row.id);
      if (this.repo.unpack(row.evidence).attributionKey !== this.repo.identity(JSON.stringify([latest.visitor_id,latest.visit_id,latest.consent_id]))) throw new ConflictException('询盘来源关联已改变，待回传事件需核对');
      await this.eligibility(latest, row.source_type, row.mode, db);
      const payload = this.repo.unpack(row.payload); checkMetaTime(payload.data[0].event_time);
      if (payload.test_event_code !== settings.testCode) throw new ConflictException('测试事件代码已改变');
      const previous = stages.slice(0, stages.indexOf(row.event_name));
      for (const name of previous) {
        const accepted = (await db.query(`SELECT occurred_at FROM marketing_meta_feedback WHERE account_id=$1 AND dataset_id=$2 AND subject_key=$3 AND event_name=$4
          AND (($5='mock' AND mode='mock' AND status='mock') OR ($5<>'mock' AND mode IN ('test','live') AND status IN ('test','accepted')))
          UNION ALL SELECT occurred_at FROM marketing_meta_legacy_receipts WHERE account_id=$1 AND dataset_id=$2 AND subject_key=$3 AND event_name=$4 AND status='accepted' AND $5<>'mock'`,
          [actor.accountId,row.dataset_id,row.subject_key,name,row.mode])).rows[0];
        if (!accepted || unix(accepted.occurred_at) > unix(row.occurred_at)) throw new ConflictException('请先回传此前阶段，并保持真实时间顺序');
      }
      // Do not upload an event already owned by the older generic delivery path.
      const other = (await db.query("SELECT id FROM conversion_deliveries WHERE primary_source_lead_id=$1 AND provider='meta' AND mode='live' AND (status IN ('accepted','dispatching','review','pending','retrying') OR attempt_count>0 OR provider_response_id IS NOT NULL) LIMIT 1", [latest.lead_id])).rows[0];
      if (row.mode !== 'mock' && other) throw new ConflictException('旧回传账本已有记录，请先核对，避免重复上传');
      const attempt = row.attempt_count + 1;
      await db.query("UPDATE marketing_meta_feedback SET status='sending',attempt_count=$2,error_code=NULL,updated_at=now() WHERE id=$1", [id, attempt]);
      await db.query("INSERT INTO marketing_meta_attempts(feedback_id,attempt,actor_id,status) VALUES($1,$2,$3,'sending')", [id, attempt, actor.userId]);
      return { duplicate: false, row, payload, attempt };
    });
    if (claim.duplicate) return claim;
    const { row, payload, attempt } = claim;
    let status: string, responseId: string | null = null, errorCode: string | null = null;
    try {
      if (row.mode === 'mock') { status = 'mock'; responseId = 'mock_' + digest(row.event_id).slice(0,16); }
      else { const receipt = await sendMetaCapi(loadConfig().meta, payload); status = row.mode === 'test' ? 'test' : 'accepted'; responseId = receipt.responseId!; }
    } catch (e) {
      status = e instanceof AdapterError && !e.uncertain ? 'rejected' : 'review';
      errorCode = e instanceof AdapterError ? e.code : 'META_OUTCOME_UNKNOWN';
    }
    // Claim was committed before the network call. A crash here leaves a reviewable claim.
    await this.repo.transaction('meta-send:' + id, async db => {
      await db.query('UPDATE marketing_meta_feedback SET status=$2,response_id=$3,error_code=$4,updated_at=now() WHERE id=$1', [id, status, responseId, errorCode]);
      await db.query('UPDATE marketing_meta_attempts SET status=$3,response_id=$4,error_code=$5 WHERE feedback_id=$1 AND attempt=$2', [id, attempt, status, responseId, errorCode]);
      await this.repo.audit(String(actor.userId), 'meta.receipt', id, { mode: row.mode, status, responseId, errorCode }, db);
    });
    return { id, status, responseId, errorCode, duplicate: false, matching: 'unknown', processing: 'unknown' };
  }
}
