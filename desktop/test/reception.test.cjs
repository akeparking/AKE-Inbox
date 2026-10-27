const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Reception } = require('../reception.cjs');
const context = () => ({ identity:'fixture', origin:'https://inbox.example.invalid', accountId:1 });
function fixture() {
  const calls=[], notices=[], changes=[]; let data={ protocolVersion:2, accountId:1, userId:7, pubsubToken:'fictional-pubsub', unreadCount:0, conversations:[] };
  const r=new Reception({ request:async(_c,action,body)=>{calls.push({action,body});return action==='desktop'?data:{protocolVersion:2,instanceOnline:body?.state!=='offline'};}, socket:()=>{const s=new EventEmitter();s.send=()=>{};s.close=()=>s.emit('close');return s;}, notify:v=>notices.push(v), changed:v=>changes.push(v) });
  return {r,calls,notices,changes,setData:v=>{data={...data,...v};}};
}
test('capability check precedes online; each process owns a different lease',async()=>{
  const a=fixture(),b=fixture();await a.r.connect(context());await b.r.connect(context());
  assert.equal(a.calls[0].action,'desktop');assert.equal(a.calls[1].body.state,'online');assert.notEqual(a.r.clientId,b.r.clientId);
  await a.r.disconnect();assert.equal(a.calls.at(-1).body.clientId,a.r.clientId);assert.equal(b.r.online,true);await b.r.disconnect();
});
test('initial unread is silent; new messages notify once; read state comes from server',async()=>{
  const f=fixture();f.setData({unreadCount:2,conversations:[{conversationId:1,lastMessageId:20,unreadCount:2}]});await f.r.connect(context());assert.equal(f.notices.length,0);
  f.setData({unreadCount:3,conversations:[{conversationId:1,lastMessageId:21,unreadCount:3}]});await f.r.snapshot();await f.r.snapshot();assert.equal(f.notices.length,1);
  f.setData({unreadCount:0,conversations:[]});await f.r.snapshot();assert.equal(f.r.unreadCount,0);await f.r.disconnect();
});
test('pause is serialized after an in-flight renewal and cannot be undone by its response',async()=>{
  const f=fixture();await f.r.connect(context());let finish;const request=f.r.request;
  f.r.request=async(c,a,b)=>{if(a==='heartbeat'&&!b.state)await new Promise(resolve=>{finish=resolve;});return request(c,a,b);};
  const pending=f.r.tick();await new Promise(setImmediate);const pause=f.r.setOnline(false);finish();await Promise.all([pending,pause]);
  assert.equal(f.r.online,false);assert.equal(f.calls.at(-1).body.state,'offline');await f.r.disconnect();
});
test('old server and API outage never produce an online state',async()=>{
  const f=fixture();f.r.request=async()=>{throw Object.assign(new Error('old'),{status:404});};await f.r.connect(context());assert.equal(f.r.online,false);assert.equal(f.changes.at(-1).connection,'incompatible');
  f.r.request=async()=>{throw Object.assign(new Error('unavailable'),{status:503});};await f.r.tick();assert.equal(f.changes.at(-1).connection,'failed');await f.r.disconnect();
});
test('expired login clears unread state and releases local identity',async()=>{
  const f=fixture();await f.r.connect(context());f.r.unreadCount=9;f.r.request=async()=>{throw Object.assign(new Error('expired'),{status:401});};await f.r.tick();assert.equal(f.r.context,null);assert.equal(f.changes.at(-1).unreadCount,0);assert.equal(f.changes.at(-1).connection,'signed_out');
});
test('suspend releases lease; resume restores active reception without changing manual pause',async()=>{
  const f=fixture();await f.r.connect(context());await f.r.suspend(true);assert.equal(f.r.online,false);assert.equal(f.calls.at(-1).body.state,'offline');await f.r.suspend(false);assert.equal(f.r.online,true);
  await f.r.setOnline(false);await f.r.suspend(true);await f.r.suspend(false);assert.equal(f.r.online,false);assert.equal(f.r.paused,true);await f.r.disconnect();
});
test('reconnection coalesces missed messages into one notification',async()=>{
  const f=fixture();await f.r.connect(context());f.r.ws.close();f.setData({unreadCount:4,conversations:[{conversationId:2,lastMessageId:42},{conversationId:3,lastMessageId:43}]});await f.r.tick();assert.equal(f.notices.length,1);assert.equal(f.notices[0].recovered,true);assert.equal(f.notices[0].count,2);await f.r.disconnect();
});
