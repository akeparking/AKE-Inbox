import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const required = name => { assert.ok(process.env[name], name + ' is required'); return process.env[name]; };
assert.equal(process.env.GOOGLE_OFFLINE_LIVE_ENABLED, 'true', 'Explicit live acceptance opt-in is required');
const root = required('GOOGLE_ACCEPTANCE_ROOT');
const authRoot = required('GOOGLE_AUTH_ROOT');
const repo = fileURLToPath(new URL('../..', import.meta.url));
const mode = process.argv[2];
assert.ok(['prepare', 'validate', 'upload', 'status', 'replay'].includes(mode));
const read = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const write = (path, value) => {
  const temporary = path + '.tmp-' + process.pid;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, path);
  const directory = fs.openSync(path.slice(0, path.lastIndexOf('/')), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
};
const scope = read(root + '/private/acceptance-scope.json');
for (const key of ['inquiry', 'serial', 'leadId', 'accountId', 'actionId', 'targetName', 'oauthProjectId']) {
  assert.ok(typeof scope[key] === 'string' && scope[key].trim(), 'Missing approved scope: ' + key);
}
assert.equal(targetGuard(), true);
function targetGuard(){ const target = read(root + '/evidence/google-conversion-target.json'); return target.optimization === 'secondary' && target.settingsReadBack === true; }
const approval = read(authRoot + '/evidence/google-operator-confirmation.json');
assert.equal(approval.inquiry, scope.inquiry);
assert.equal(approval.dataCollectionAndSharingAttested, true);
assert.equal(approval.qualification, 'confirmed');
const target = read(root + '/evidence/google-conversion-target.json');
assert.equal(target.accountId, scope.accountId);
assert.equal(target.actionId, scope.actionId);
assert.equal(target.name, scope.targetName);
assert.equal(target.optimization, 'secondary');
assert.equal(target.count, 'ONE');
assert.equal(target.value, 'not_used');
const captured = read(authRoot + '/private/selected-attribution.json');
assert.ok(captured.identifiers.gclid, 'This ONE-count acceptance requires an existing GCLID');
const selected = { ...captured, identifiers: { gclid: captured.identifiers.gclid } }; // Keep original evidence intact; do not mix BRAID into this ONE-count upload.
assert.equal(selected.serial, scope.serial);
assert.equal(selected.leadId, scope.leadId);
const require = createRequire(repo + '/package.json');
const { Pool } = require('pg');
const dbUrl = new URL(required('GOOGLE_TEST_DATABASE_URL'));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname), 'Isolated local database required');
const databaseName = dbUrl.pathname.slice(1);
assert.match(databaseName, /^ake_google_acceptance(?:_[a-z0-9_]+)?$/, 'Dedicated acceptance database required');
const workspaceId = 'ake-google-acceptance';
const statePath = root + '/private/google-case.json';
const state = fs.existsSync(statePath) ? read(statePath) : { encryptionKey: randomBytes(32).toString('hex'), realPostCount: 0 };
write(statePath, state);
const token = read(authRoot + '/private/google-oauth-token.json');
assert.ok(token.expires_at * 1000 > Date.now() + 60000, 'Refresh dedicated OAuth credential first');
Object.assign(process.env, { DATABASE_URL: dbUrl.toString(), FIELD_ENCRYPTION_KEY: state.encryptionKey,
  DEFAULT_WORKSPACE_ID: workspaceId, ADS_MODE: 'live', DEMO_SEED: 'false', OKKI_WRITE_ENABLED: 'false',
  GOOGLE_DATA_MANAGER_ACCESS_TOKEN: token.access_token, GOOGLE_ADS_ACCOUNT_ID: target.accountId,
  GOOGLE_CONVERSION_ACTION_ID: target.actionId, GOOGLE_VALIDATE_ONLY: 'false' });
const { PostgresRevenueStore } = require(repo + '/apps/revenue-core/dist/store/postgres.store.js');
const { GoogleAdsAdapter } = require(repo + '/apps/revenue-core/dist/conversion/adapters.js');
const { ConversionService } = require(repo + '/apps/revenue-core/dist/conversion/conversion.service.js');
const { loadConfig } = require(repo + '/apps/revenue-core/dist/config.js');
const { redactPayload } = require(repo + '/apps/revenue-core/dist/common/http.js');
const payloadHash = payload => { const { validateOnly, ...rest } = payload; return hash(JSON.stringify(rest)); };
const scrub = value => {
  let text = JSON.stringify(value);
  for (const id of Object.values(selected.identifiers)) text = text.split(id).join('[click identifier]');
  return JSON.parse(text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'));
};
let store, db, transportCalls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://datamanager.googleapis.com');
  assert.ok(['/v1/events:ingest', '/v1/requestStatus:retrieve'].includes(url.pathname));
  if (url.pathname === '/v1/events:ingest') {
    assert.ok(['validate', 'upload'].includes(mode));
    const payload = JSON.parse(init.body);
    assert.equal(payload.events.length, 1);
    assert.equal(payload.destinations.length, 1);
    assert.equal(payload.destinations[0].operatingAccount.accountId, target.accountId);
    assert.equal(payload.destinations[0].productDestinationId, target.actionId);
    const event = payload.events[0];
    assert.equal(event.transactionId, state.eventId);
    assert.equal(event.eventTimestamp, state.occurredAt);
    assert.ok(JSON.stringify(event.adIdentifiers) === JSON.stringify(selected.identifiers), 'Click identifiers do not match the approved evidence');
    assert.equal(event.userData, undefined);
    assert.equal(event.conversionValue, undefined);
    assert.equal(event.currency, undefined);
    assert.equal(event.consent.adPersonalization, 'CONSENT_DENIED');
    assert.equal(payload.validateOnly, mode === 'validate');
    assert.equal(transportCalls.filter(x => x.method === 'POST').length, 0);
    if (mode === 'upload') {
      assert.equal(state.realPostCount, 0, 'Prior ingestion attempt requires reconciliation; never blind-retry');
      assert.ok(Date.now() >= new Date(target.uploadNotBefore).getTime(), 'New conversion propagation window');
      assert.equal(payloadHash(payload), state.validatedPayloadHash);
      state.realPostCount = 1; state.uploadStartedAt = new Date().toISOString(); write(statePath, state);
    }
  } else {
    assert.equal(url.searchParams.get('requestId'), state.requestId);
  }
  const receipt = { at: new Date().toISOString(), method: init.method || 'GET', path: url.pathname, mode, validateOnly: mode === 'validate' };
  transportCalls.push(receipt);
  const response = await originalFetch(input, init);
  const body = await response.clone().json().catch(() => ({}));
  receipt.httpStatus = response.status;
  receipt.body = scrub(body);
  fs.appendFileSync(root + '/evidence/google-transport.jsonl', JSON.stringify(receipt) + '\n');
  return response;
};

try {
  if (mode === 'prepare') {
    const adminUrl = new URL(dbUrl); adminUrl.pathname = '/postgres';
    const admin = new Pool({ connectionString: adminUrl.toString() });
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName])).rowCount)
      await admin.query('CREATE DATABASE ' + databaseName);
    await admin.end();
  }
  db = new Pool({ connectionString: dbUrl.toString() });
  if (mode === 'prepare') {
    const directory = repo + '/apps/revenue-core/dist/database/migrations';
    for (const name of fs.readdirSync(directory).filter(x => x.endsWith('.sql')).sort())
      await db.query(fs.readFileSync(directory + '/' + name, 'utf8'));
  }
  store = new PostgresRevenueStore(dbUrl.toString(), state.encryptionKey);
  const qualify = () => store.qualifyLead({ workspaceId, leadId: state.leadId,
    actorId: 'operator:explicit-chat-confirmation', contactReachable: true, relevantNeed: true, targetBuyer: true,
    nextAction: 'One approved click-only Google LeadQualified acceptance; no customer outreach.' });
  if (mode === 'prepare') {
    const landing = new URL(selected.landingPage); landing.search = ''; landing.hash = '';
    const lead = await store.ingestLead({ workspaceId, provider: 'google', sourceKind: 'manual',
      externalLeadId: `okki:lead:${scope.leadId}:qualification:v1`, displayName: scope.inquiry, isTest: false,
      attribution: { provider: 'google', sourceKind: 'manual', occurredAt: approval.confirmedAt,
        identifiers: Object.entries(selected.identifiers).map(([type, value]) => ({ type: 'google_' + type, value })),
        landingUrl: landing.toString(), utm: selected.utm, consentStatus: 'granted',
        metadata: { source: 'operator_selected_crm_import', originalWebsiteConsent: 'unknown',
          consent: { adStorage: 'granted', adUserData: 'granted', adPersonalization: 'denied' },
          consentBasis: 'Explicit operator attestation for this manual click-identifier import only; not historical browser CMP evidence',
          approvalSha256: hash(fs.readFileSync(authRoot + '/evidence/google-operator-confirmation.json')),
          approvalAt: approval.confirmedAt, approvedInquiry: scope.serial, qualificationBasis: 'Operator confirmed valid in this chat',
          originalInquiryReference: selected.sourceUrl, importedContactFields: [] } } });
    state.leadId = lead.id;
    const qualified = await qualify();
    // Backfill the documented human qualification time, never the replay/import time.
    // Only this isolated, never-attempted acceptance event can be backfilled.
    const savedTimes = (await db.query('SELECT e.occurred_at AS event_time, d.occurred_at AS delivery_time FROM conversion_deliveries d JOIN conversion_events e ON e.id=d.conversion_event_id WHERE d.id=$1', [qualified.delivery.id])).rows[0];
    assert.ok(savedTimes);
    if (new Date(savedTimes.event_time).getTime() !== new Date(approval.confirmedAt).getTime() || new Date(savedTimes.delivery_time).getTime() !== new Date(approval.confirmedAt).getTime()) {
      assert.equal(state.realPostCount, 0);
      assert.ok(!state.validatedPayloadHash, 'Do not change an already validated payload');
      const occurredAt = new Date(approval.confirmedAt).toISOString();
      assert.ok(new Date(occurredAt).getTime() <= Date.now());
      const transaction = await db.connect();
      try {
        await transaction.query('BEGIN');
        const changed = await transaction.query("UPDATE conversion_deliveries SET occurred_at=$1 WHERE id=$2 AND status='pending' AND attempt_count=0 RETURNING id", [occurredAt, qualified.delivery.id]);
        assert.equal(changed.rowCount, 1);
        const eventChanged = await transaction.query('UPDATE conversion_events SET occurred_at=$1 WHERE id=(SELECT conversion_event_id FROM conversion_deliveries WHERE id=$2)', [occurredAt, qualified.delivery.id]);
        assert.equal(eventChanged.rowCount, 1);
        await transaction.query("INSERT INTO audit_log(id,workspace_id,actor_id,action,entity_type,entity_id,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          ['audit_' + randomBytes(16).toString('hex'), workspaceId, 'operator:explicit-chat-confirmation', 'qualification.import_documented_time', 'conversion_event', qualified.delivery.eventId,
            { eventTime: savedTimes.event_time, deliveryTime: savedTimes.delivery_time }, { occurredAt, evidenceSha256: hash(fs.readFileSync(authRoot + '/evidence/google-operator-confirmation.json')) }]);
        await transaction.query('COMMIT');
        qualified.delivery.occurredAt = occurredAt;
      } catch (error) { await transaction.query('ROLLBACK'); throw error; }
      finally { transaction.release(); }
    }
    state.deliveryId = qualified.delivery.id; state.eventId = qualified.delivery.eventId;
    state.occurredAt = qualified.delivery.occurredAt; write(statePath, state);
    const again = await qualify(); assert.equal(again.deduplicated, true); assert.equal(again.delivery.eventId, state.eventId);
    const encrypted = (await db.query('SELECT value_ciphertext FROM ad_identifiers')).rows;
    assert.ok(encrypted.length === 1 && encrypted.every(x => x.value_ciphertext.startsWith('gcm:')));
    write(root + '/evidence/google-prepared.json', { status: 'prepared', inquiry: scope.serial, sourceKind: 'manual',
      eventId: state.eventId, deliveryId: state.deliveryId, eventTimestamp: state.occurredAt,
      qualificationDeduplicated: true, historicalCmpConsent: 'unknown', permissionBasis: 'explicit operator attestation for this import',
      contactsImported: false, amountsIncluded: false, clickIdentifiersEncrypted: true, uploadedIdentifierTypes: ['gclid'], originalBraidRetainedOnlyInSourceEvidence: true, eventTimeBasis: 'documented operator qualification time', isolatedLocalDatabase: databaseName,
      uploadNotBefore: target.uploadNotBefore, eventsUploaded: 0 });
  } else {
    const context = await store.getQualifiedContext(state.deliveryId);
    assert.ok(context && !context.lead.isTest && !context.lead.email && !context.lead.phone && !context.opportunity);
    const adapter = new GoogleAdsAdapter(loadConfig());
    if (mode === 'validate') {
      const payload = adapter.buildQualifiedPayload(context); payload.validateOnly = true;
      const result = await adapter.send(payload);
      const response = transportCalls.at(-1);
      assert.ok(result.validatedOnly && !response.body.fieldWarnings?.length, 'Validation warnings require review');
      state.validatedPayloadHash = payloadHash(payload); state.validatedAt = new Date().toISOString(); write(statePath, state);
      await store.updateDelivery(state.deliveryId, { receiptStages: result.receiptStages, payloadPreview: redactPayload(payload) });
      write(root + '/evidence/google-validation.json', { ...result, checkedAt: state.validatedAt,
        eventId: state.eventId, payloadHash: state.validatedPayloadHash, ingestionExecuted: false, fieldWarnings: [] });
    } else if (mode === 'upload') {
      assert.ok(Date.now() >= new Date(target.uploadNotBefore).getTime(), 'Propagation window not reached');
      assert.equal(state.realPostCount, 0, 'Prior upload attempt requires reconciliation');
      const rows = await new ConversionService(store).processBatch(1);
      assert.equal(rows.length, 1); assert.equal(rows[0].id, state.deliveryId);
      state.requestId = rows[0].providerResponseId; write(statePath, state);
      write(root + '/evidence/google-upload.json', { checkedAt: new Date().toISOString(), delivery: rows[0],
        actualPostCount: state.realPostCount, customerContactsUploaded: false, amountsUploaded: false });
    } else if (mode === 'status') {
      assert.ok(state.requestId, 'No accepted request to query');
      const stages = await adapter.queryReceipt(state.requestId);
      await store.updateDelivery(state.deliveryId, { receiptStages: stages });
      write(root + '/evidence/google-processing.json', { checkedAt: new Date().toISOString(), requestId: state.requestId, receiptStages: stages });
    } else if (mode === 'replay') {
      const again = await qualify(); assert.equal(again.deduplicated, true); assert.equal(again.delivery.eventId, state.eventId);
      assert.equal((await new ConversionService(store).processBatch(1)).length, 0);
      const counts = (await db.query('SELECT (SELECT count(*)::int FROM conversion_events) events,(SELECT count(*)::int FROM conversion_deliveries) deliveries,(SELECT count(*)::int FROM opportunities) opportunities')).rows[0];
      assert.deepEqual(counts, { events: 1, deliveries: 1, opportunities: 0 });
      write(root + '/evidence/google-replay.json', { status: 'passed', ...counts, additionalUploads: 0, stableEventId: state.eventId });
    }
  }
  console.log(JSON.stringify({ mode, result: 'completed', networkRequests: transportCalls.map(({ body, ...rest }) => rest), vpsModified: false }));
} catch (error) {
  const result = { mode, result: 'blocked_or_failed', error: error.name, code: error.code || null,
    message: scrub(String(error.message)), checkedAt: new Date().toISOString() };
  write(root + '/evidence/google-' + mode + '-error.json', result); console.error(JSON.stringify(result)); process.exitCode = 1;
} finally {
  if (store) await store.close();
  if (db) await db.end();
}
