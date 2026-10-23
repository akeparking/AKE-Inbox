import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const root=process.env.LOCAL_RUNTIME_ROOT;if(!root)throw Error('LOCAL_RUNTIME_ROOT required');
const env=Object.fromEntries((await fs.readFile(root+'/private/core.env','utf8')).trim().split('\n').map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)];}));Object.assign(process.env,env);
const u=new URL(env.DATABASE_URL);u.hostname='localhost';u.port='14623';process.env.DATABASE_URL=u.href;
const {InboxRepository}=await import('../../apps/revenue-core/dist/inbox-v2/repository.js');const {MarketingService}=await import('../../apps/revenue-core/dist/marketing/service.js');const repo=new InboxRepository(),service=new MarketingService(repo,null,null,null);
try{
 process.env.ATTRIBUTION_CAPTURE_ENABLED='false';const s=await service.session({siteId:'local-acceptance',pageUrl:'http://localhost:14621/',policyVersion:'flag-test',consent:{analytics:'granted'}},'http://localhost:14621');assert.equal(s.visitorToken,null);assert.equal(s.coverage.captureEnabled,false);
 const receipt=await service.submit({siteId:'local-acceptance',sessionToken:s.sessionToken,sourceSubmissionId:randomUUID(),formId:'a0000000-0000-4000-8000-000000000001',version:1,fields:{name:'Flag fixture',email:'flag@example.invalid',company:'Fictional test',message:'Tracking disabled, form still works'}},'http://localhost:14621');assert.equal(receipt.confirmed,true);
 const row=(await repo.db.query('SELECT visitor_id,visit_id FROM marketing_inquiries WHERE id=$1',[receipt.inquiryId])).rows[0];assert.equal(row.visitor_id,null);assert.equal(row.visit_id,null);await assert.rejects(service.events({},'http://localhost:14621'),/Tracking is disabled/);
 await fs.writeFile(root+'/qa/feature-flags.json',JSON.stringify({result:'passed',captureDisabled:true,formPersisted:true,historyInvented:false},null,2));console.log('PASS capture rollback preserves truthful form intake');
}finally{await repo.onModuleDestroy();}
