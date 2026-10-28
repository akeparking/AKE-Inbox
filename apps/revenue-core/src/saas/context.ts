import { AsyncLocalStorage } from "node:async_hooks";
import type { TenantRole } from "@ake/contracts";

export interface TenantContext {
  workspaceId: string;
  accountId: number;
  userId: string;
  role: TenantRole;
  slug: string;
  name: string;
  effectiveFrom: string;
  settings: Record<string, any>;
  chatwootUrl: string;
  credentials?: Record<string, string>;
  sessionHash?: string;
  system?: boolean;
}
export const tenantContext = new AsyncLocalStorage<TenantContext>();
export const saasEnabled = () => process.env.SAAS_MODE === "true";
export function currentTenant(): TenantContext {
  const tenant = tenantContext.getStore();
  if (!tenant) throw new Error("tenant_context_required");
  return tenant;
}
