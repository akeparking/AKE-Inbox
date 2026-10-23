import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive, authorized, signedChatwoot, deliveryStatus, shouldAdvance, channelBindings, dispatchBinding } from '../../deploy/demo/whatsapp/archive.mjs';

test('raw inbound/outbound/media/delete events survive reopening without retaining transport secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ake-wa-archive-'));
  const archive = new Archive(join(dir, 'events.sqlite'));
  for (const event of ['messages.upsert','send.message','messages.delete']) {
    const payload = {instance:'fixture', event, apikey:'secret', data:{key:{id:'test'}, message:{imageMessage:{caption:'original'}}}};
    assert.equal(archive.accept(payload, 'fixture'), true);
    archive.accept(payload, 'fixture');
  }
  assert.equal(archive.summary().events, 3);
  for (const row of archive.db.prepare('SELECT payload FROM events').all()) {
    assert.equal(row.payload.includes('secret'), false);
    assert.equal(JSON.parse(row.payload).data.message.imageMessage.caption, 'original');
  }
  assert.equal(archive.accept({event:'messages.upsert', instance:'other', data:{}}, 'fixture'), false);
  archive.db.close();
  const reopened = new Archive(join(dir, 'events.sqlite'));
  assert.equal(reopened.summary().events, 3);
  reopened.db.close();
  rmSync(dir, {recursive: true});
});

test('delivery status only advances and duplicate callbacks enqueue once', () => {
  const archive = new Archive(':memory:');
  const payload = {instance:'fixture', event:'messages.update', data:{keyId:'test', fromMe:true, status:'DELIVERY_ACK'}};
  archive.accept(payload,'fixture'); archive.accept(payload,'fixture');
  assert.equal(archive.summary().jobs[0].n, 1);
  assert.equal(deliveryStatus('DELIVERY_ACK'), 'delivered');
  assert.equal(deliveryStatus('PLAYED'), 'read');
  assert.equal(shouldAdvance('read','sent'), false);
  assert.equal(shouldAdvance('delivered','failed'), false);
  assert.equal(shouldAdvance('sent','read'), true);
  assert.equal(shouldAdvance('read','read'), false);
});

test('webhook authorization fails closed', () => {
  assert.equal(authorized('Bearer correct','correct'), true);
  assert.equal(authorized(undefined,'correct'), false);
  assert.equal(authorized('Bearer undefined',undefined), false);
  assert.equal(authorized('Bearer invalid','correct'), false);
});

test('seat channels route by both account and inbox, with independent signing keys', () => {
  const config={account_id:1,bindings:[{inbox_id:4,instance:'seat-a',dispatch_key:'key-a'},{inbox_id:5,instance:'seat-b',dispatch_key:'key-b'}]};
  assert.equal(dispatchBinding(config,{account:{id:1},inbox:{id:5}}).instance,'seat-b');
  assert.equal(dispatchBinding(config,{account:{id:2},inbox:{id:5}}),null);
  assert.equal(dispatchBinding(config,{account:{id:1},inbox:{id:99}}),null);
  assert.throws(()=>channelBindings({...config,bindings:[...config.bindings,config.bindings[0]]}));
  const archive=new Archive(':memory:');
  const data={keyId:'same-provider-id',fromMe:true,status:'READ'};
  for(const instance of ['seat-a','seat-b']) archive.accept({instance,event:'messages.update',data},instance);
  assert.equal(archive.summary().jobs[0].n,2);
  const instances=archive.db.prepare('SELECT payload FROM jobs').all().map(j=>JSON.parse(j.payload).instance);
  assert.deepEqual(instances.sort(),['seat-a','seat-b']);
});

test('Chatwoot callbacks require the exact body and a current HMAC signature', () => {
  const raw=Buffer.from('{"event":"message_created"}'), stamp='1791023000', secret='test-webhook-secret';
  const signature='sha256='+createHmac('sha256',secret).update(stamp+'.').update(raw).digest('hex');
  const headers={'x-chatwoot-timestamp':stamp,'x-chatwoot-signature':signature};
  assert.equal(signedChatwoot(raw,headers,secret,Number(stamp)*1000),true);
  assert.equal(signedChatwoot(Buffer.from('{}'),headers,secret,Number(stamp)*1000),false);
  assert.equal(signedChatwoot(raw,headers,secret,Number(stamp)*1000+301000),false);
  assert.equal(signedChatwoot(raw,{},secret,Number(stamp)*1000),false);
});

test('duplicate sends and uncertain sends after a restart are not forwarded twice', () => {
  const dir=mkdtempSync(join(tmpdir(),'ake-dispatch-')), path=join(dir,'events.sqlite');
  const first=new Archive(path), body={event:'message_created',account:{id:1},id:19};
  assert.equal(first.claimDispatch(body).claimed,true);
  assert.equal(first.claimDispatch(body).claimed,false);
  first.db.close();
  const reopened=new Archive(path), claim=reopened.claimDispatch(body);
  assert.equal(claim.claimed,false);
  assert.equal(claim.state,'review');
  reopened.db.close();rmSync(dir,{recursive:true});
});
