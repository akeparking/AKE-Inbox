// Dedicated fresh installation only. Exercises the actual BullMQ worker against
// its own PostgreSQL and Redis database 14; all conversion transport stays Mock.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import pg from 'pg';
import IORedis from 'ioredis';
import {Queue} from 'bullmq';
const require=createRequire(import.meta.url);
const {PostgresRevenueStore}=require('../../apps/revenue-core/dist/store/postgres.store.js');
const root=process.env.LOCAL_REBUILD_ROOT;
if(!root?.startsWith('/home/'))throw Error('Fresh private WSL runtime required');
const install=JSON.parse(await fs.readFile(root+'/private/local-install.json','utf8'));
assert.equal(install.status,'ready');assert.match(install.project,/^ake-mkt-rebuild-/);
const settings=Object.fromEntries((await fs.readFile(root+'/private/core.env','utf8')).split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)];}));
assert.equal(settings.LOCAL_EMPTY_INSTALL,'true');assert.equal(settings.ADS_MODE,'mock');
const url=new URL(settings.DATABASE_URL);url.hostname='127.0.0.1';url.port=String(install.basePort+3);
const db=new pg.Client({connectionString:url.href});await db.connect();
const redisUrl=`redis://127.0.0.1:${install.basePort+4}/14`,redis=new IORedis(redisUrl,{maxRetriesPerRequest:null});
const queue=new Queue('qualified-feedback',{connection:redis}),store=new PostgresRevenueStore(url.href,settings.FIELD_ENCRYPTION_KEY);
const compose=['compose','--env-file',root+'/private/compose.env','-f','deploy/marketing/compose.local.yaml','--profile','marketing'];
execFileSync('docker',[...compose,'stop','worker'],{stdio:'ignore'});
const workspaceId='local-queue-recovery-'+randomUUID();
const environment={PATH:process.env.PATH,NODE_ENV:'test',DATABASE_URL:url.href,REDIS_URL:redisUrl,STORE_DRIVER:'postgres',FIELD_ENCRYPTION_KEY:settings.FIELD_ENCRYPTION_KEY,DEMO_SEED:'false',ADS_MODE:'mock',INBOX_V2_ENABLED:'false',MARKETING_ENABLED:'false',OKKI_WRITE_ENABLED:'false',INBOX_AUTO_SEND:'false',DEFAULT_WORKSPACE_ID:workspaceId};
let worker,workerLog,round=0;
const forbiddenRequests=root+'/private/queue-forbidden-requests.log',guard=root+'/private/queue-transport-guard.cjs';
await fs.writeFile(forbiddenRequests,'',{mode:0o600});
await fs.writeFile(guard,`const fs=require('node:fs');const original=global.fetch;global.fetch=(url,opts)=>{const host=new URL(String(url)).hostname;if(!['localhost','127.0.0.1','::1'].includes(host)){fs.appendFileSync(${JSON.stringify(forbiddenRequests)},'blocked external request\\n');throw Error('External transport forbidden in recovery test');}return original(url,opts);};`,{mode:0o600});
async function start(enabled=true){
  workerLog=await fs.open(root+'/private/recovery-worker-'+(++round)+'.log','w',0o600);
  worker=spawn(process.execPath,['--require',guard,'apps/revenue-core/dist/worker.js'],{env:{...environment,QUALIFIED_FEEDBACK_ENABLED:String(enabled)},stdio:['ignore',workerLog.fd,workerLog.fd]});
}
async function stop(){if(!worker)return;const current=worker;worker=null;current.kill('SIGTERM');await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{current.kill('SIGKILL');reject(Error('Worker did not shut down cleanly'));},15000);current.once('exit',()=>{clearTimeout(timer);resolve();});});await workerLog.close();}
const read=async id=>(await store.listDeliveries(workspaceId)).find(row=>row.id===id);
async function waitFor(fn,label){for(let n=0;n<100;n++){if(await fn())return;if(worker?.exitCode!==null&&worker?.exitCode!==undefined)throw Error('Worker exited unexpectedly');await new Promise(resolve=>setTimeout(resolve,200));}throw Error(label);}
async function qualified(label){
  const lead=await store.ingestLead({workspaceId,provider:'organic',sourceKind:'website',externalLeadId:label,displayName:'Fictional recovery fixture',isTest:true,attribution:{provider:'organic',sourceKind:'website',occurredAt:new Date().toISOString(),identifiers:[]}});
  const command={workspaceId,leadId:lead.id,actorId:'fixture',contactReachable:true,relevantNeed:true,targetBuyer:true,nextAction:'Local recovery acceptance'};
  return {...await store.qualifyLead(command),command};
}
const evidence={result:'in_progress',boundary:'fresh local stack; actual BullMQ and PostgreSQL; transport Mock; no external upload',cases:[]};
try {
  const first=await qualified('queue-before-loss');await start();await waitFor(async()=>(await read(first.delivery.id)).status==='accepted','Initial outbox was not processed');await stop();
  assert.ok(await redis.dbsize());await redis.flushdb();assert.equal(await redis.dbsize(),0);
  const pending=await qualified('queue-after-loss'),interrupted=await qualified('interrupted-outcome'),held=await qualified('live-record-under-mock');
  await db.query("UPDATE conversion_deliveries SET status='dispatching',updated_at=now()-interval '6 minutes' WHERE id=$1",[interrupted.delivery.id]);
  // Persist an explicit live-mode fixture, without any real ad identifiers or credentials.
  await db.query("UPDATE conversion_deliveries SET mode='live' WHERE id=$1",[held.delivery.id]);
  await start(false);await waitFor(async()=>(await queue.getJobCounts('completed')).completed>0,'Disabled worker did not process its scan trigger');
  assert.equal((await read(pending.delivery.id)).status,'pending');await stop();
  evidence.cases.push({id:'Q01',status:'passed',proof:'feedback disabled preserves durable pending event while real queue scheduler runs'});
  await start();await waitFor(async()=>(await read(pending.delivery.id)).status==='accepted','PostgreSQL outbox did not recover after Redis loss');
  assert.equal((await read(interrupted.delivery.id)).status,'review');assert.equal((await read(interrupted.delivery.id)).attemptCount,0);
  assert.equal((await read(held.delivery.id)).status,'pending');assert.equal((await read(held.delivery.id)).attemptCount,0);
  evidence.cases.push({id:'Q02',status:'passed',proof:'empty dedicated Redis DB rebuilt scheduler and consumed durable PostgreSQL outbox'});
  evidence.cases.push({id:'Q03',status:'passed',proof:'interrupted dispatch held for reconciliation; no automatic replay'});
  evidence.cases.push({id:'Q04',status:'passed',proof:'persisted live fixture unchanged under Mock worker'});
  await stop();const replay=await store.qualifyLead(pending.command);assert.equal(replay.delivery.id,pending.delivery.id);assert.equal(replay.deduplicated,true);
  const completedBefore=(await queue.getJobCounts('completed')).completed;
  await start();await waitFor(async()=>(await queue.getJobCounts('completed')).completed>completedBefore,'Restart scan did not complete');await stop();
  assert.equal((await read(pending.delivery.id)).attemptCount,1);assert.equal((await read(first.delivery.id)).attemptCount,1);
  const events=(await db.query('SELECT count(*)::int n FROM conversion_events WHERE workspace_id=$1',[workspaceId])).rows[0].n;assert.equal(events,4);
  evidence.cases.push({id:'Q05',status:'passed',proof:'repeated qualification and process restart preserve four events, accepted fixtures have one attempt each'});
  assert.equal(await fs.readFile(forbiddenRequests,'utf8'),'');
  evidence.result='passed';evidence.eventCount=events;evidence.externalTransportAttempts=0;
  await fs.writeFile(root+'/qa/queue-recovery.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
} finally {await stop();await queue.close();await redis.quit();await store.close();await db.end();execFileSync('docker',[...compose,'start','worker'],{stdio:'ignore'});}
