import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const root=process.env.GOOGLE_ACCEPTANCE_ROOT;
const authRoot=process.env.GOOGLE_AUTH_ROOT;
assert.ok(root && authRoot && process.env.GOOGLE_TEST_DATABASE_URL, 'Explicit acceptance paths and database are required');
const require=createRequire(new URL('../../package.json',import.meta.url));
const {Pool}=require('pg');
const url=new URL(process.env.GOOGLE_TEST_DATABASE_URL);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
assert.match(url.pathname,/^\/ake_google_acceptance(?:_[a-z0-9_]+)?$/);
const db=new Pool({connectionString:url.toString()});
try{
 const counts=(await db.query('SELECT (SELECT count(*)::int FROM conversion_events) events,(SELECT count(*)::int FROM conversion_deliveries) deliveries,(SELECT count(*)::int FROM opportunities) opportunities')).rows[0];
 assert.deepEqual(counts,{events:1,deliveries:1,opportunities:0});
 const row=(await db.query('SELECT d.event_key,d.status,d.mode,d.attempt_count,d.occurred_at AS delivery_time,e.occurred_at AS event_time FROM conversion_deliveries d JOIN conversion_events e ON e.id=d.conversion_event_id')).rows[0];
 const approval=JSON.parse(fs.readFileSync(authRoot+'/evidence/google-operator-confirmation.json'));
 assert.equal(new Date(row.event_time).getTime(),new Date(approval.confirmedAt).getTime());assert.equal(new Date(row.delivery_time).getTime(),new Date(row.event_time).getTime());
 const ids=(await db.query('SELECT identifier_type AS type,value_ciphertext FROM ad_identifiers')).rows;assert.equal(ids.length,1);assert.equal(ids[0].type,'google_gclid');assert.ok(ids[0].value_ciphertext.startsWith('gcm:'));
 const caseState=JSON.parse(fs.readFileSync(root+'/private/google-case.json'));assert.equal(caseState.eventId,row.event_key);
 const proof={checkedAt:new Date().toISOString(),result:'passed',...counts,status:row.status,mode:row.mode,attemptCount:row.attempt_count,realUploadAttempts:caseState.realPostCount,eventAndDeliveryTimeAgree:true,timeBasis:'documented operator confirmation',eventTimestamp:row.event_time,identifierTypes:['gclid'],identifierEncrypted:true,stableEventId:row.event_key,productionDatabaseConnected:false,vpsConnected:false};
 fs.writeFileSync(root+'/evidence/google-database-readback.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{await db.end();}
