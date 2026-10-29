import { ServiceUnavailableException } from "@nestjs/common";
import { currentTenant } from "./context";
import type { TenantsService } from "./tenants.service";

export class GoogleOAuthError extends Error {
  constructor(readonly code: string) { super(code); }
}

export async function refreshGoogleToken(credentials: any) {
  if (!credentials.refreshToken || !credentials.clientId || !credentials.clientSecret)
    throw new GoogleOAuthError("google_refresh_configuration_required");
  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refreshToken,
        client_id: credentials.clientId, client_secret: credentials.clientSecret }),
    });
  } catch { throw new GoogleOAuthError("google_refresh_unavailable"); }
  if (!response.ok) throw new GoogleOAuthError(response.status === 429 ? "rate_limited" :
    response.status >= 500 ? "google_refresh_unavailable" : "authorization_revoked");
  const data: any = await response.json().catch(() => ({}));
  if (typeof data.access_token !== "string" || !data.access_token || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0)
    throw new GoogleOAuthError("invalid_google_refresh_response");
  return { ...credentials, accessToken: data.access_token, expiresAt: Date.now() + Number(data.expires_in) * 1000,
    ...(typeof data.refresh_token === "string" && data.refresh_token ? { refreshToken: data.refresh_token } : {}) };
}

/** Refresh under the tenant's row lock; concurrent edits and workers retain the newest secrets. */
export async function googleFeedbackCredentials(tenants: TenantsService) {
  const a = currentTenant(), db = await tenants.registry.connect();
  try {
    await db.query("BEGIN");
    const row = (await db.query("SELECT secrets FROM saas_tenants WHERE workspace_id=$1 FOR UPDATE", [a.workspaceId])).rows[0];
    const secrets = tenants.unseal(a.workspaceId, row?.secrets);
    let google = secrets.feedback?.google;
    if (google?.refreshToken && (!google.expiresAt || google.expiresAt < Date.now() + 60000)) {
      google = await refreshGoogleToken(google);
      secrets.feedback.google = google;
      await db.query("UPDATE saas_tenants SET secrets=$2 WHERE workspace_id=$1", [a.workspaceId, tenants.seal(a.workspaceId, secrets)]);
    }
    await db.query("COMMIT");
    return google;
  } catch (e) {
    await db.query("ROLLBACK");
    if (e instanceof GoogleOAuthError) throw new ServiceUnavailableException(e.code);
    throw e;
  } finally { db.release(); }
}
