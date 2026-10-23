import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';

export function authorized(actual, secret) {
  if (typeof secret !== 'string' || !secret.length) return false;
  const a = Buffer.from(actual || ''), b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function signedChatwoot(raw, headers, secret, now = Date.now()) {
  const stamp = headers['x-chatwoot-timestamp'];
  if (!secret || !/^\d{10}$/.test(stamp || '') || Math.abs(now / 1000 - Number(stamp)) > 300) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(stamp + '.').update(raw).digest('hex');
  return authorized('Bearer ' + headers['x-chatwoot-signature'], expected);
}
export function deliveryStatus(value) {
  return ({ SERVER_ACK: 'sent', DELIVERY_ACK: 'delivered', READ: 'read', PLAYED: 'read', ERROR: 'failed' })[value] || null;
}
export function shouldAdvance(current, next) {
  if (current === next) return false;
  if (next === 'failed') return !['delivered', 'read'].includes(current);
  const rank = { failed: -1, sent: 0, delivered: 1, read: 2 };
  return next in rank && (rank[next] > (rank[current] ?? -1));
}
export function channelBindings(config) {
  const bindings = config.bindings || [{ inbox_id: config.inbox_id, instance: config.instance, dispatch_key: config.dispatch_key, controlled: true }];
  if (!bindings.length || new Set(bindings.map(b => b.inbox_id)).size !== bindings.length || new Set(bindings.map(b => b.instance)).size !== bindings.length ||
      bindings.some(b => !Number.isSafeInteger(b.inbox_id) || !/^[a-zA-Z0-9_-]+$/.test(b.instance) || !b.dispatch_key)) throw new Error('invalid_channel_bindings');
  return bindings;
}
export function dispatchBinding(config, body) {
  if (body.account?.id !== config.account_id) return null;
  return channelBindings(config).find(b => b.inbox_id === body.inbox?.id) || null;
}
export class Archive {
  constructor(path) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS events (sha TEXT PRIMARY KEY, event TEXT NOT NULL, payload TEXT NOT NULL, received TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (sha TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatches (key TEXT PRIMARY KEY, state TEXT NOT NULL, received TEXT NOT NULL);
      UPDATE dispatches SET state='review' WHERE state='processing';`);
  }
  accept(body, instance) {
    const events = ['messages.upsert','messages.update','messages.delete','messages.set','send.message','send.message.update','messages.edit','chatwoot.webhook'];
    if (body.instance !== instance || !events.includes(body.event) || !body.data) return false;
    // Transport API keys and authorization headers are not conversation content.
    const payload = JSON.stringify({ event: body.event, instance, date_time: body.date_time ?? null, data: body.data });
    const sha = createHash('sha256').update(payload).digest('hex');
    this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)').run(sha, body.event, payload, new Date().toISOString());
    if (body.event === 'messages.update') {
      for (const value of Array.isArray(body.data) ? body.data : [body.data]) {
        if (!value.fromMe || !value.keyId || !deliveryStatus(value.status)) continue;
        const text = JSON.stringify({...value, instance}), id = createHash('sha256').update(text).digest('hex');
        this.db.prepare('INSERT OR IGNORE INTO jobs(sha,payload) VALUES(?,?)').run(id, text);
      }
    }
    return true;
  }
  claimDispatch(body) {
    const key = body.event === 'message_created'
      ? `message:${body.account.id}:${body.id}`
      : createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const result = this.db.prepare("INSERT OR IGNORE INTO dispatches VALUES(?,'processing',?)").run(key, new Date().toISOString());
    return {key, claimed:result.changes===1, state:this.db.prepare('SELECT state FROM dispatches WHERE key=?').get(key).state};
  }
  completeDispatch(key, state) {
    this.db.prepare('UPDATE dispatches SET state=? WHERE key=?').run(state,key);
  }
  summary() {
    return { events: this.db.prepare('SELECT count(*) AS n FROM events').get().n,
      jobs: this.db.prepare('SELECT state,count(*) AS n FROM jobs GROUP BY state').all(),
      dispatches: this.db.prepare('SELECT state,count(*) AS n FROM dispatches GROUP BY state').all() };
  }
}
