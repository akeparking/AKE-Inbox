import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fakeChatwoot, modules } from "./fixtures.mjs";
const require = createRequire(import.meta.url);
const { ConversationsService } = require("../../apps/revenue-core/dist/saas/conversations.service.js");

test("native webhook verifies its source through a gateway that drops underscore headers", async () => {
  process.env.SAAS_TEST_MODE = "true";
  process.env.NODE_ENV = "test";
  const cw = await fakeChatwoot();
  const m = modules(), saved = [];
  const tenants = {
    bySlug: async () => ({ workspace_id: "fixture", secrets: "fixture" }),
    unseal: () => ({ chatwootWebhookToken: "a".repeat(64), chatwootServiceToken: "fictional-service-token" }),
    fromRow: () => ({ workspaceId: "fixture", accountId: 10, userId: "system:chatwoot", role: "admin", chatwootUrl: cw.url }),
    db: { query: async () => ({ rows: [{ channel: "email" }] }) },
    fetchChatwoot: m.TenantsService.prototype.fetchChatwoot,
  };
  try {
    const service = new ConversationsService(tenants, { receive: async v => { saved.push(v); return { state: "persisted" }; } });
    const result = await service.webhook("fixture-ake", "a".repeat(64), { event: "message_created", id: 100, conversation: { id: 1 } });
    assert.equal(result.state, "persisted");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].eventId, "100");
    assert.equal(saved[0].source, "email");
  } finally { await cw.close(); }
});
