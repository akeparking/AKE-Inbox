import type { Conversation, Fields } from './contracts';

export function stopReason(c: Pick<Conversation, 'mode' | 'blocked' | 'opted_out' | 'native_status'>) {
  if (c.blocked) return 'blocked';
  if (c.opted_out) return 'opted_out';
  if (c.mode !== 'ai') return 'human_or_paused';
  if (c.native_status === 'resolved') return 'closed';
  return null;
}
export function cleanIncoming(text: string) {
  return text.split(/\n(?:On .{5,200}wrote:|在.{2,200}写道[:：]|-{3,}\s*Original Message\s*-{3,})/i)[0].trim().slice(0,16000);
}
export function isAutomaticMail(body: any, text: string) {
  const attrs = body.content_attributes || {};
  const headers = Object.fromEntries(Object.entries(attrs.email?.headers || attrs.headers || {}).map(([k,v])=>[k.toLowerCase(),String(v)]));
  return /^(?:auto-replied|auto-generated)$/i.test(headers['auto-submitted'] || '') ||
    /^(?:bulk|junk|list)$/i.test(headers.precedence || '') ||
    /delivery status notification|undeliverable:|automatic reply:|out of office|自动回复|退信/i.test(String(attrs.email?.subject || body.subject || '')) ||
    /^\s*(?:mailer-daemon|postmaster)@/i.test(body.sender?.email || '') ||
    /^\s*This is an automatically generated Delivery Status Notification/i.test(text);
}
export const humanRequest = (text: string) => /\b(human|salesperson|speak to (?:a |an )?(?:person|agent)|talk to (?:sales|a person))\b|转人工|人工客服|销售人员/i.test(text);
export const optedOut = (text: string) => /^\s*(stop|unsubscribe|opt out|退订|停止联系)\s*[.!！。]?\s*$/i.test(text);
export const commitmentRequest = (text: string) => /\b(price|pricing|quotation|quote|certif\w*|guarantee|delivery date|lead time)\b|报价|价格|交期|认证|保证兼容|承诺/i.test(text);
// These questions collect project facts or start reception; they do not ask
// for a product claim. Any other uncovered question keeps the knowledge gate.
export function intakeQuestion(text: string) {
  const questions=text.match(/[^?？。.!！;；\n]+[?？]/g)||[];
  const patterns=[
    /^(?:(?:你好|您好)[，, ]*)?(?:请问)?(?:现在)?(?:有人|有客服)(?:可以)?(?:接待|在线)(?:吗|么)?[?？]$/,
    /^(?:我们|我|请问)?(?:还需要|需要|应该|应当|要)(?:先)?(?:准备|整理|提供|补充)?(?:哪些|什么)(?:项目)?(?:资料|信息|材料)[?？]$/,
    /^(?:what|which) (?:project )?(?:information|details|documents) (?:do|should|can|must) (?:i|we) (?:prepare|provide|share|send)\s*\?$/i,
    /^(?:hello[, ]*)?(?:is anyone (?:available|online)|can (?:i|we) (?:start|continue) (?:a |the )?(?:chat|conversation))\s*\?$/i,
  ];
  return questions.length>0&&questions.every(question=>patterns.some(pattern=>pattern.test(question.trim())));
}
export function mergeFields(old: Fields, next: Partial<Fields>, confirmed: string[]) {
  const result = { ...old };
  for (const [key, value] of Object.entries(next)) {
    if (confirmed.includes(key) || value === null || value === undefined || (Array.isArray(value) && !value.length)) continue;
    (result as any)[key] = value;
  }
  return result;
}
export function workTime(at: Date, zone: string): Date {
  const parts = (d: Date) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(p => [p.type, p.value]));
  let t = new Date(at);
  // Walk absolute minutes across timezone/DST changes; never reinterpret local time as UTC.
  for (let i = 0; i <= 24 * 60; i++) {
    const p = parts(t), h = Number(p.hour);
    if (h >= 9 && h < 18) return t;
    t = new Date(t.getTime() + 60000);
  }
  throw new Error('invalid_working_timezone');
}
export function followupDates(after: Date, timezone: string | null) {
  if (!timezone) return [];
  try { return [24,72].map(hours => workTime(new Date(after.getTime() + hours * 3600000), timezone)); }
  catch { return []; }
}
export function csvCell(value: unknown) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@\-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"','""') + '"';
}

export function supportedEvidence(value: unknown, quote: string) {
  const norm=(v:unknown)=>String(v).normalize('NFKC').toLowerCase().replace(/[,，]/g,'').replace(/\s+/g,' ').trim();
  if(typeof value==='number')return (quote.replace(/[,，]/g,'').match(/\d+(?:\.\d+)?/g)||[]).some(n=>Number(n)===value);
  if(Array.isArray(value))return value.every(v=>norm(quote).includes(norm(v)));
  return norm(quote).includes(norm(value));
}
