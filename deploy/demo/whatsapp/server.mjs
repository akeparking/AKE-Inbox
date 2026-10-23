import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Archive, authorized, signedChatwoot, deliveryStatus, shouldAdvance, channelBindings, dispatchBinding } from './archive.mjs';
import {bridgeControl} from './bridge-control.mjs';

const require = createRequire('/deps/package.json');
const { Pool } = require('pg');
const config = JSON.parse(readFileSync('/private/whatsapp-archive.json', 'utf8'));
const bindings = channelBindings(config);
const archive = new Archive('/data/events.sqlite');
const pool = new Pool({ connectionString: config.database_url, max: 1, connectionTimeoutMillis: 10000, query_timeout: 10000 });
let pollStatus = 'not_checked';

async function api(path, body) {
  const response = await fetch(config.chatwoot_url + '/api/v1/accounts/' + config.account_id + path, {
    method: body ? 'PATCH' : 'GET', signal: AbortSignal.timeout(15000),
    headers: { api_access_token: config.chatwoot_token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error('chatwoot_http_' + response.status);
  return response.json();
}

async function syncOne() {
  const row = archive.db.prepare("SELECT * FROM jobs WHERE state='pending' AND next_at<=? ORDER BY next_at, rowid LIMIT 1").get(Date.now());
  if (!row) return;
  try {
    const value = JSON.parse(row.payload);
    const binding = bindings.find(b => b.instance === (value.instance || config.instance));
    if (!binding) throw new Error('unknown_instance');
    const found = await pool.query(`SELECT m."chatwootMessageId" AS mid, m."chatwootConversationId" AS cid, m."chatwootInboxId" AS iid
      FROM "Message" m JOIN "Instance" i ON i.id=m."instanceId"
      WHERE i.name=$1 AND m.key->>'id'=$2 AND m.key->>'fromMe'='true' LIMIT 1`, [binding.instance, value.keyId]);
    const item = found.rows[0];
    if (!item?.mid || !item?.cid) throw new Error('mapping_pending');
    if (item.iid !== binding.inbox_id) throw new Error('scope_mismatch');
    const path = `/conversations/${item.cid}/messages`;
    const result = await api(path + '?before=' + (item.mid + 1));
    const message = result.payload?.find(m => m.id === item.mid);
    if (!message || message.source_id !== 'WAID:' + value.keyId) throw new Error('source_mismatch');
    const next = deliveryStatus(value.status);
    if (shouldAdvance(message.status, next)) {
      await api(path + '/' + item.mid, { status: next });
      const receipt = await api(path + '?before=' + (item.mid + 1));
      const observed = receipt.payload?.find(m => m.id === item.mid)?.status;
      if (observed !== next && shouldAdvance(observed, next)) throw new Error('readback_failed');
    }
    archive.db.prepare("UPDATE jobs SET state='synced' WHERE sha=?").run(row.sha);
  } catch {
    archive.db.prepare("UPDATE jobs SET attempts=attempts+1,next_at=?,state=? WHERE sha=?")
      .run(Date.now() + Math.min(300000, 1000 * 2 ** Math.min(row.attempts, 9)), row.attempts >= 30 ? 'review' : 'pending', row.sha);
  }
}

async function reconcile() {
  // Recover missed delivery callbacks from the connector's durable update table.
  for (const binding of bindings) {
  const key = 'update_cursor:' + binding.instance;
  const cursor = archive.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || '';
  const result = await pool.query(`SELECT u.* FROM "MessageUpdate" u JOIN "Instance" i ON i.id=u."instanceId"
    WHERE i.name=$1 AND u.id>$2 ORDER BY u.id LIMIT 500`, [binding.instance, cursor]);
  for (const row of result.rows) {
    archive.accept({event:'messages.update', instance:binding.instance, data:row}, binding.instance);
    archive.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, row.id);
  }
  }
  pollStatus = 'ok';
}

let busy = false, lastPoll = 0;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    if (Date.now() - lastPoll > 60000) { lastPoll = Date.now(); await reconcile(); }
    await syncOne();
  } catch { pollStatus = 'retrying'; }
  finally { busy = false; }
}, 1000).unref();

createServer(async (req, res) => {
  const reply = (code, value) => { res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(value)); };
  if (req.url === '/health' && req.method === 'GET') return reply(200, {status:'ok', database_sync:pollStatus, ...archive.summary()});
  const dispatch = req.url === '/whatsapp/dispatch';
  if ((!dispatch && req.url !== '/webhook') || req.method !== 'POST') return reply(404, {error:'not_found'});
  if (!dispatch && !authorized(req.headers.authorization, config.archive_key)) return reply(401, {error:'unauthorized'});
  try {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) return reply(413, {error:'too_large'});
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(raw);
    if (dispatch) {
      const binding = dispatchBinding(config, body);
      if (!binding)
        return reply(200, {accepted:false});
      if (!signedChatwoot(raw, req.headers, binding.dispatch_key)) return reply(401, {error:'invalid_signature'});
      archive.accept({event:'chatwoot.webhook',instance:binding.instance,data:body}, binding.instance);
      if (binding.controlled !== false && config.inbox_core_url && body.event==='message_created' && [1,'outgoing'].includes(body.message_type) && !body.private && !config.excluded_conversations?.includes(body.conversation?.id)) {
        const gate=await fetch(config.inbox_core_url+'/api/v1/inbox-v2/admission',{method:'POST',headers:{'content-type':'application/json','x-inbox-key':config.inbox_internal_key},body:JSON.stringify({accountId:config.account_id,conversationId:body.conversation?.id,jobId:body.content_attributes?.ake_inbox_job,revision:body.content_attributes?.ake_inbox_revision,provider:'evolution'}),signal:AbortSignal.timeout(8000)});
        if(!gate.ok)return reply(503,{error:'admission_unavailable'});
        const decision=await gate.json();if(!decision.allowed||decision.managedBridge&&!config.marketing_bridge_control)return reply(200,{accepted:false,reason:'sending_cancelled_or_shared_guard_required'});
      }
      const controlled=body.event==='message_created'&&[1,'outgoing'].includes(body.message_type)&&!body.private;
      if(controlled&&!(await bridgeControl(config,body,'claim')).allowed)return reply(200,{accepted:false,reason:'bridge_ownership_or_replay'});
      const claim = archive.claimDispatch(body);
      if (!claim.claimed) {if(controlled&&config.marketing_bridge_control)await bridgeControl(config,body,'receipt','review');return reply(claim.state==='review' ? 503 : 200, {accepted:claim.state!=='review',duplicate:true});}
      try {
        const response = await fetch('http://whatsapp-web:8080/chatwoot/webhook/' + binding.instance, {
          method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000),
        });
        // An uncertain send is surfaced as failed for human review; never retry
        // an external message blindly from this relay.
        archive.completeDispatch(claim.key, response.ok ? 'accepted' : 'review');
        if(controlled)await bridgeControl(config,body,'receipt',response.ok?'accepted':'review');
        return reply(response.ok ? 200 : 502, {accepted:response.ok});
      } catch { archive.completeDispatch(claim.key, 'review');if(controlled)await bridgeControl(config,body,'receipt','review').catch(()=>undefined);return reply(502, {error:'delivery_unconfirmed'}); }
    }
    const binding = bindings.find(b => b.instance === body.instance);
    const accepted = binding ? archive.accept(body, binding.instance) : false;
    reply(accepted ? 202 : 200, {accepted});
  } catch { reply(400, {error:'invalid_event'}); }
}).listen(4312, '0.0.0.0');
