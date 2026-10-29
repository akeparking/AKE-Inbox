import { currentTenant } from "./context";
import { TenantsService } from "./tenants.service";

export async function leadMessages(tenants: TenantsService, leadId: string) {
  const a = currentTenant(),
    rows = (
      await tenants.db.query(
        "SELECT * FROM inbox_messages WHERE workspace_id=$1 AND lead_id=$2 ORDER BY occurred_at DESC,id DESC LIMIT 201",
        [a.workspaceId, leadId],
      )
    ).rows;
  return {
    truncated: rows.length > 200,
    items: rows
      .slice(0, 200)
      .reverse()
      .map((row) => ({
        id: row.id,
        leadId: row.lead_id,
        channel: row.channel,
        occurredAt: new Date(row.occurred_at).toISOString(),
        message: tenants.cipher(a.workspaceId).decrypt(row.message_ciphertext),
        isTest: row.is_test,
      })),
  };
}
