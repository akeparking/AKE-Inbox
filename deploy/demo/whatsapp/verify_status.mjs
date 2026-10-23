import fs from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const {Pool} = createRequire('/deps/package.json')('pg');
const config = JSON.parse(fs.readFileSync('/private/whatsapp-archive.json'));
const [mid,cid,iid] = process.argv.slice(2).map(Number);
assert([mid,cid,iid].every(Number.isSafeInteger));
const key = 'AKE-STATUS-TEST-20261003';
const messages = `${config.chatwoot_url}/api/v1/accounts/${config.account_id}/conversations/${cid}/messages`;
async function readback() {
  const response = await fetch(messages+'?before='+(mid+1),{headers:{api_access_token:config.chatwoot_token}});
  assert(response.ok);
  return (await response.json()).payload.find(m=>m.id===mid);
}
const initial = await readback();
assert.equal(initial.private,true);
assert(initial.content.startsWith('[AKE ARCHIVE TEST]'));
assert.equal(initial.source_id,'WAID:'+key);
const pool = new Pool({connectionString:config.database_url,max:1});
await pool.query(`INSERT INTO "Message" (id,key,"messageType",message,source,"messageTimestamp","chatwootMessageId","chatwootConversationId","chatwootInboxId","instanceId")
  SELECT $1,$2,'conversation',$3,'web',$4,$5,$6,$7,id FROM "Instance" WHERE name=$8
  ON CONFLICT(id) DO NOTHING`, ['ake-private-status-verification', JSON.stringify({id:key,fromMe:true,remoteJid:'archive-fixture@lid'}),
  JSON.stringify({conversation:'Private synthetic status verification'}),Math.floor(Date.now()/1000),mid,cid,iid,config.instance]);
const observed=[];
for (const [upstream,expected] of [['DELIVERY_ACK','delivered'],['READ','read'],['SERVER_ACK','read']]) {
  const response=await fetch('http://127.0.0.1:4312/webhook',{method:'POST',headers:{authorization:'Bearer '+config.archive_key,'content-type':'application/json'},
    body:JSON.stringify({event:'messages.update',instance:config.instance,data:{keyId:key,fromMe:true,status:upstream}})});
  assert.equal(response.status,202);
  let actual;
  for(let i=0;i<25;i++){
    await new Promise(r=>setTimeout(r,1000));
    actual=(await readback()).status;
    if(actual===expected || (initial.status==='read' && actual==='read'))break;
  }
  assert(actual===expected || (initial.status==='read' && actual==='read'));
  observed.push({upstream,status:actual});
}
console.log(JSON.stringify({passed:true,private_fixture:true,external_message_sent:false,message_id:mid,observed}));
await pool.end();
