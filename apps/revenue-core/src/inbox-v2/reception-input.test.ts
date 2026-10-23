import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {InboxAutomation} from './automation.service';
let service:InboxAutomation;
const c:any={account_id:1,conversation_id:9,channel:'email'};
const message={id:99,created_at:Date.now()/1000,content:'Parking project'};
const db={query:vi.fn(async()=>({rows:[{n:1}]}))};
beforeEach(()=>{
  vi.stubEnv('INBOX_V2_ENABLED','false');vi.stubEnv('INBOX_EFFECTIVE_FROM','2026-01-01T00:00:00Z');
  service=new InboxAutomation({} as any,{} as any,{} as any,{} as any);
  vi.spyOn(service,'automaticEmail').mockResolvedValue(false);
  db.query.mockResolvedValue({rows:[{n:1}]});
});
afterEach(()=>vi.unstubAllEnvs());
it('does not revive automatic email through the offline reconciliation lane',async()=>{
  expect(await service.receptionInput(c,{...message,content_attributes:{email:{headers:{'auto-submitted':'auto-generated'}}}},db)).toBeNull();
  vi.mocked(service.automaticEmail).mockResolvedValue(true);
  expect(await service.receptionInput(c,message,db)).toBeNull();
});
it('preserves historical, human-request and rate restrictions',async()=>{
  expect(await service.receptionInput(c,{...message,created_at:1},db)).toBeNull();
  expect(await service.receptionInput(c,{...message,content:'Please connect me to a human'},db)).toBeNull();
  db.query.mockResolvedValue({rows:[{n:21}]});
  expect(await service.receptionInput(c,message,db)).toBeNull();
});
it('resumes a current eligible customer inquiry',async()=>{
  expect(await service.receptionInput(c,message,db)).toBe('Parking project');
});
