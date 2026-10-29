import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export async function fakeChatwoot(port = 0) {
  const sent = [],
    revoked = new Set();
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, "http://fixture"),
      chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    const send = (status, value, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    if (path.pathname === "/auth/sign_in") {
      if (body.password !== "fixture-password") return send(401, {});
      const user = body.email.startsWith("viewer")
        ? 2
        : body.email.startsWith("sales")
          ? 3
          : body.email.startsWith("marketing")
            ? 4
            : 1;
      return send(
        200,
        { data: { id: user, accounts: [{ id: 10 }, { id: 20 }] } },
        {
          "access-token": "fixture-" + user,
          uid: body.email,
          client: "fixture-client",
          "token-type": "Bearer",
        },
      );
    }
    const user = Number(
      String(req.headers["access-token"] || "").split("-")[1],
    );
    // Public gateways can drop underscore-named headers. Exercise the
    // hyphenated header that Rails normalizes to HTTP_API_ACCESS_TOKEN.
    if (!req.headers["api-access-token"] && (!user || revoked.has(user)))
      return send(401, {});
    if (path.pathname === "/api/v1/profile")
      return send(200, { id: user, accounts: [{ id: 10 }, { id: 20 }] });
    const match = path.pathname.match(/^\/api\/v1\/accounts\/(10|20)\/(.*)$/);
    if (!match) return send(404, {});
    const account = Number(match[1]),
      route = match[2],
      inboxId = account === 10 ? 101 : 201;
    if (route === "agents")
      return send(
        200,
        [1, 2, 3, 4, 5].map((id) => ({ id })),
      );
    if (route === "inboxes")
      return send(200, {
        payload: [
          {
            id: inboxId,
            name: "Fictional Inbox",
            channel_type: "Channel::Email",
          },
        ],
      });
    const conversation = {
      id: 1,
      account_id: account,
      inbox_id: inboxId,
      created_at: Math.floor(Date.now() / 1000),
      meta: { sender: { name: "Fictional Buyer", email: "same@example.test" } },
    };
    if (route === "conversations")
      return send(200, { data: { payload: [conversation] } });
    if (route === "conversations/1") return send(200, conversation);
    if (route === "conversations/1/messages" && req.method === "GET")
      return send(200, {
        payload: [
          {
            id: 100,
            message_type: 0,
            content: "Fictional email inquiry",
            created_at: Math.floor(Date.now() / 1000),
            sender: conversation.meta.sender,
          },
        ],
      });
    if (route === "conversations/1/messages" && req.method === "POST") {
      sent.push({ account, key: body.content_attributes?.ake_operation_key });
      return send(200, { id: 1000 + sent.length });
    }
    if (route === "conversations/1/assignments")
      return send(200, { assignee_id: body.assignee_id });
    return send(404, {});
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    url: "http://127.0.0.1:" + server.address().port,
    sent,
    revoked,
    close: () => new Promise((r) => server.close(r)),
  };
}
export async function provisionFixtures(
  pool,
  tenants,
  chatwootUrl,
  suffix = randomUUID().slice(0, 8),
) {
  const rows = [];
  for (const [slug, account, template] of [
    ["fixture-ake", 10, "ake-parking"],
    ["fixture-external", 20, "general-b2b"],
  ]) {
    const workspaceId = slug + "-" + suffix,
      secret = "fixture-signing-secret-" + suffix + "-012345678901234567890";
    // Use dedicated fixture database only. Account IDs cannot map to two tenants.
    await pool.query(
      "INSERT INTO workspaces(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [
        workspaceId,
        slug === "fixture-ake" ? "AKE 虚构测试组织" : "外部虚构测试组织",
      ],
    );
    await pool.query(
      "INSERT INTO saas_tenants(workspace_id,slug,chatwoot_account_id,chatwoot_url,enabled,effective_from,settings,secrets) VALUES($1,$2,$3,$4,true,$5,$6,$7)",
      [
        workspaceId,
        slug,
        account,
        chatwootUrl,
        new Date(Date.now() - 86400000).toISOString(),
        {
          template,
          timezone: "UTC",
          monthlyInquiryLimit: 10000,
          monthlyAiLimit: 1000,
          feedbackMode: "mock",
        },
        tenants.seal(workspaceId, {
          intakeSecret: secret,
          chatwootWebhookToken: "a".repeat(64),
          chatwootServiceToken: "fixture-service",
          model: { provider: "mock" },
        }),
      ],
    );
    for (const [userId, role] of [
      ["1", "admin"],
      ["2", "viewer"],
      ["3", "sales"],
      ["4", "marketing"],
    ])
      await pool.query(
        "INSERT INTO saas_members(workspace_id,user_id,role) VALUES($1,$2,$3)",
        [workspaceId, userId, role],
      );
    rows.push({ workspaceId, slug, account, secret });
  }
  return rows;
}
export function signed(body, secret) {
  const raw = JSON.stringify(body),
    timestamp = String(Math.floor(Date.now() / 1000));
  return {
    raw,
    headers: {
      "content-type": "application/json",
      "x-intake-timestamp": timestamp,
      "x-intake-signature": createHmac("sha256", secret)
        .update(timestamp + "." + raw)
        .digest("hex"),
    },
  };
}
export function inquiry(overrides = {}) {
  const now = new Date().toISOString();
  return {
    source: "website",
    eventId: "same-external-event",
    projectId: "project-one",
    occurredAt: now,
    displayName: "Fictional Buyer",
    email: "same@example.test",
    companyName: "Fictional Engineering",
    country: "AE",
    message:
      "Please quote a parking project. Fictional acceptance fixture only.",
    isTest: true,
    attribution: {
      provider: "meta",
      sourceKind: "website",
      occurredAt: now,
      consentStatus: "granted",
      identifiers: [
        { type: "campaign_id", value: "9001001" },
        { type: "meta_fbc", value: "fb.1.000000.fixture" },
      ],
      metadata: {
        accountId: "900001",
        campaignId: "9001001",
        consent: {
          adStorage: "granted",
          adUserData: "granted",
          adPersonalization: "denied",
        },
      },
    },
    ...overrides,
  };
}
export const modules = () => ({
  NestFactory: require("@nestjs/core").NestFactory,
  AppModule: require("../../apps/revenue-core/dist/app.module.js").AppModule,
  TenantsService:
    require("../../apps/revenue-core/dist/saas/tenants.service.js")
      .TenantsService,
  AdsService: require("../../apps/revenue-core/dist/saas/ads.service.js")
    .AdsService,
  FeedbackService:
    require("../../apps/revenue-core/dist/saas/feedback.service.js")
      .FeedbackService,
  tenantContext: require("../../apps/revenue-core/dist/saas/context.js")
    .tenantContext,
  REVENUE_STORE: require("../../apps/revenue-core/dist/store/store.types.js")
    .REVENUE_STORE,
});
