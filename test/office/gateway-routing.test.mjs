// Run in an isolated container with web/workspace/saas-workspace mapped to
// 127.0.0.2 / 127.0.0.3 / 127.0.0.4. Never run on the office host ports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
test('gateway preserves legacy reception and routes only explicit CRM paths',async()=>{
 assert.equal(process.env.GATEWAY_ISOLATED_TEST,'true');
 const servers=[];
 for(const [host,name] of [['127.0.0.2','native'],['127.0.0.3','workspace'],['127.0.0.4','crm']]){
  const s=http.createServer((q,r)=>r.end(name+':'+q.method+':'+q.url));await new Promise(ok=>s.listen(3000,host,ok));servers.push(s);
 }
 const child=spawn(process.execPath,['deploy/office/gateway.mjs'],{env:{...process.env,OFFICE_READ_ONLY:'false',OFFICE_SAAS_HOST:'saas-workspace'},stdio:'inherit'});
 try{
  for(let n=0;n<100;n++){try{await fetch('http://127.0.0.1:14721/sales');break;}catch{await new Promise(r=>setTimeout(r,50));}}
  for(const path of ['/sales','/sales/inbox','/sales/api/inbox/session','/sales/_next/static/a.js','/sales/api/saas-foreign/x','/sales/saas-foreign']){
   const r=await fetch('http://127.0.0.1:14721'+path);assert.equal(await r.text(),'workspace:GET:'+path);
  }
  for(const path of ['/sales/saas','/sales/api/saas/session','/sales/api/saas-hooks/meta-leads/example?hub.challenge=123']){
   const r=await fetch('http://127.0.0.1:14721'+path,{method:'POST',body:'fixture'});assert.equal(await r.text(),'crm:POST:'+path);
  }
  assert.equal(await (await fetch('http://127.0.0.1:14720/app/login')).text(),'native:GET:/app/login');
  await new Promise(r=>servers[2].close(r));
  assert.equal((await fetch('http://127.0.0.1:14721/sales/api/saas-hooks/intake/example',{method:'POST',body:'fixture'})).status,503);
  assert.equal((await fetch('http://127.0.0.1:14721/sales/inbox')).status,200);
 }finally{child.kill('SIGTERM');await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));}
});
