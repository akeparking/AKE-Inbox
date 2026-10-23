import {afterEach,expect,it,vi} from 'vitest';
import {allowedWorkspaceOrigin} from './workspace-origin';
afterEach(()=>vi.unstubAllEnvs());
it('allows only the configured public and office loopback origins',()=>{
  vi.stubEnv('WORKSPACE_PUBLIC_ORIGIN','https://office.example.invalid');
  vi.stubEnv('WORKSPACE_ALLOWED_ORIGINS','http://localhost:14721');
  expect(allowedWorkspaceOrigin('https://office.example.invalid','http://internal:3000')).toBe(true);
  expect(allowedWorkspaceOrigin('http://localhost:14721','http://internal:3000')).toBe(true);
  for(const origin of [null,'null','https://office.example.invalid.attacker.invalid','http://localhost:14722','http://internal:3000'])
    expect(allowedWorkspaceOrigin(origin,'http://internal:3000')).toBe(false);
});
