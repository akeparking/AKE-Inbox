import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { createHmac, randomUUID } from "node:crypto";
import {
  fakeChatwoot,
  provisionFixtures,
  signed,
  inquiry,
  modules,
} from "./fixtures.mjs";

test("isolated PostgreSQL SaaS acceptance", async (t) => {
  assert.equal(process.env.SAAS_TEST_MODE, "true");
  const adminUrl = new URL(process.env.SAAS_TEST_ADMIN_URL);
  assert.equal(adminUrl.hostname, "127.0.0.1");
  assert.match(adminUrl.pathname, /saas.*test|inbox_saas/);
  // Dedicated acceptance database is rebuilt; no office or production URLs accepted.
  const pool = new pg.Pool({ connectionString: adminUrl.toString() });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  const dir = new URL(
    "../../apps/revenue-core/src/database/migrations/",
    import.meta.url,
  );
  for (const name of (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pool.query(await readFile(new URL(name, dir), "utf8"));
  await pool.query(
    await readFile(
      new URL("../../deploy/saas/enable-rls.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(
    "GRANT USAGE ON SCHEMA public TO saas_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO saas_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO saas_runtime",
  );
  const cw = await fakeChatwoot(),
    m = modules();
  let app = await m.NestFactory.create(m.AppModule, {
    rawBody: true,
    logger: false,
  });
  const tenants = app.get(m.TenantsService),
    ads = app.get(m.AdsService),
    feedback = app.get(m.FeedbackService);
  const [a, b] = await provisionFixtures(pool, tenants, cw.url);
  await app.listen(0, "127.0.0.1");
  let base = await app.getUrl();
  const nativeFetch = global.fetch;
  const req = async (path, token, body, extra = {}) => {
    const r = await nativeFetch(base + "/api/v1/saas/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-saas-session": token } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const ok = async (...args) => {
    const r = await req(...args);
    assert.ok(
      r.status >= 200 && r.status < 300,
      JSON.stringify({ path: args[0], status: r.status, body: r.body }),
    );
    return r.body;
  };
  const login = async (slug, email = "admin@example.test") =>
    (await ok("session", null, { slug, email, password: "fixture-password" }))
      .token;
  const ta = await login(a.slug),
    tb = await login(b.slug),
    tv = await login(a.slug, "viewer@example.test"),
    ts = await login(a.slug, "sales@example.test"),
    tm = await login(a.slug, "marketing@example.test");
  const intake = async (tenant, body) => {
    const v = signed(body, tenant.secret),
      r = await nativeFetch(base + "/api/v1/saas/intake/" + tenant.slug, {
        method: "POST",
        headers: v.headers,
        body: v.raw,
      });
    return { status: r.status, body: await r.json() };
  };
  const context = async (tenant, fn) =>
    m.tenantContext.run(
      tenants.fromRow(await tenants.bySlug(tenant.slug), "1", "admin"),
      fn,
    );
  let leadA, leadB, deal, quote, connection, qualified;
  const sample = inquiry();
  try {
    await t.test(
      "identity ignores client tenant headers; readonly and revoked membership enforced",
      async () => {
        assert.equal((await req("records/leads", undefined)).status, 401);
        assert.equal(
          (
            await ok("session", ta, undefined, {
              "x-workspace-id": b.workspaceId,
              "x-user-id": "999",
            })
          ).slug,
          a.slug,
        );
        assert.equal(
          (await req("companies", tv, { name: "Forbidden", ownerId: "2" }))
            .status,
          403,
        );
        assert.equal((await req("ad-connections", ts, {})).status, 403);
        cw.revoked.add(3);
        assert.equal((await req("session", ts)).status, 401);
        cw.revoked.delete(3);
        const legacy = await nativeFetch(base + "/api/v1/leads", {
          headers: { "x-saas-session": ta },
        });
        assert.equal(legacy.status, 403);
      },
    );
    await t.test(
      "duplicate and concurrent intake; identical external IDs and emails remain tenant local",
      async () => {
        const results = await Promise.all(
          Array.from({ length: 5 }, () => intake(a, sample)),
        );
        assert.ok(
          results.every((r) => r.status === 201),
          JSON.stringify(results),
        );
        leadA = results[0].body.leadId;
        assert.ok(results.every((r) => r.body.leadId === leadA));
        const other = await intake(b, sample);
        assert.equal(other.status, 201);
        leadB = other.body.leadId;
        assert.notEqual(leadA, leadB);
        assert.equal((await ok("records/leads", ta)).total, 1);
        assert.equal((await ok("records/leads", tb)).total, 1);
        assert.equal((await req("leads/" + leadB, ta)).status, 404);
        const exportA = await ok("export/leads", ta);
        assert.equal(exportA.rows.length, 1);
        assert.equal(exportA.rows[0].id, leadA);
        assert.equal(
          (await intake(a, { ...sample, message: "changed" })).status,
          409,
        );
      },
    );
    await t.test(
      "database denies missing context, cross-tenant reads, writes, references and pool leakage",
      async () => {
        assert.equal(
          (await tenants.db.query("SELECT id FROM leads")).rowCount,
          0,
        );
        await context(a, async () => {
          assert.equal(
            (await tenants.db.query("SELECT id FROM leads")).rows[0].id,
            leadA,
          );
          await assert.rejects(
            () =>
              tenants.db.query(
                "INSERT INTO companies(id,workspace_id,name) VALUES($1,$2,$3)",
                ["bad-tenant", b.workspaceId, "bad"],
              ),
            (e) => e.code === "42501",
          );
        });
        const checks = await Promise.all(
          Array.from({ length: 24 }, (_, i) =>
            context(i % 2 ? a : b, async () =>
              (await tenants.db.query("SELECT id FROM leads")).rows.map(
                (r) => r.id,
              ),
            ),
          ),
        );
        checks.forEach((ids, i) =>
          assert.deepEqual(ids, [i % 2 ? leadA : leadB]),
        );
        assert.equal(
          (await tenants.db.query("SELECT id FROM leads")).rowCount,
          0,
        );
      },
    );
    await t.test(
      "cutover follows original project time; missing source stays unattributed",
      async () => {
        const old = await intake(
          a,
          inquiry({
            eventId: "old-project-reply",
            projectId: "old-project",
            projectStartedAt: "2020-01-01T00:00:00.000Z",
          }),
        );
        assert.equal(old.body.state, "legacy_okki");
        const organic = inquiry({
          source: "whatsapp",
          eventId: "organic",
          projectId: "organic",
          attribution: {
            provider: "organic",
            sourceKind: "whatsapp",
            occurredAt: new Date().toISOString(),
            identifiers: [],
            consentStatus: "unknown",
          },
        });
        assert.equal((await intake(a, organic)).status, 201);
        const report = await ok(
          "reports?from=" +
            sample.occurredAt.slice(0, 10) +
            "&to=" +
            sample.occurredAt.slice(0, 10) +
            "&mode=mock",
          ta,
        );
        assert.equal(report.summary.unattributed, 1);
        assert.equal(report.campaigns[0].leads, 1);
        assert.equal(report.campaigns[0].spend, null);
        assert.equal(report.campaigns[0].complete, false);
      },
    );
    await t.test(
      "multiple projects per customer, independent qualification, idempotent opportunities and version conflicts",
      async () => {
        const detail = await ok("leads/" + leadA, ta),
          body = {
            primarySourceLeadId: leadA,
            name: "Project Alpha",
            ownerId: "1",
            nextAction: "Confirm requirements",
            idempotencyKey: randomUUID(),
          };
        const results = await Promise.all([
          ok("opportunities", ta, body),
          ok("opportunities", ta, body),
        ]);
        deal = results[0].opportunity;
        assert.equal(results[1].opportunity.id, deal.id);
        assert.equal((await ok("leads/" + leadA, ta)).lead.status, "new");
        const second = (
          await ok("opportunities", ta, {
            ...body,
            name: "Project Beta",
            idempotencyKey: randomUUID(),
          })
        ).opportunity;
        assert.notEqual(second.id, deal.id);
        assert.equal(second.person_id, detail.lead.personId);
        assert.equal(
          (
            await req("opportunities", ta, {
              ...body,
              primarySourceLeadId: leadB,
              idempotencyKey: randomUUID(),
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await req("opportunities/" + deal.id + "/stage", tb, {
              stage: "quotation",
              expectedVersion: 0,
            })
          ).status,
          404,
        );
        qualified = await ok("leads/" + leadA + "/qualify", ta, {
          contactReachable: true,
          relevantNeed: true,
          targetBuyer: true,
          nextAction: "Prepare quotation",
        });
        const repeated = await ok("leads/" + leadA + "/qualify", ta, {
          contactReachable: true,
          relevantNeed: true,
          targetBuyer: true,
          nextAction: "Prepare quotation",
        });
        assert.equal(repeated.delivery.id, qualified.delivery.id);
        await ok("opportunities/" + deal.id + "/stage", ta, {
          stage: "quotation",
          expectedVersion: 0,
        });
        assert.equal(
          (
            await req("opportunities/" + deal.id + "/stage", ta, {
              stage: "negotiation",
              expectedVersion: 0,
            })
          ).status,
          409,
        );
        deal.version = 1;
      },
    );
    await t.test(
      "quote revisions and winning/reopening retain immutable history without duplicate events",
      async () => {
        quote = await ok("quotes", ta, {
          opportunityId: deal.id,
          title: "Proposal Q1",
          amount: 1000,
          currency: "USD",
          idempotencyKey: randomUUID(),
        });
        const q2 = await ok("quotes", ta, {
          opportunityId: deal.id,
          title: "Proposal Q2",
          amount: 1200,
          currency: "USD",
          previousId: quote.id,
          idempotencyKey: randomUUID(),
        });
        assert.equal(q2.version, 2);
        assert.equal(
          (
            await req("quotes", ta, {
              opportunityId: deal.id,
              title: "Stale proposal",
              amount: null,
              currency: "USD",
              previousId: quote.id,
              idempotencyKey: randomUUID(),
            })
          ).status,
          409,
        );
        const body = {
          expectedVersion: 1,
          status: "won",
          amount: 1100,
          currency: "USD",
          occurredAt: new Date().toISOString(),
          evidence: "Fictional signed acceptance",
          idempotencyKey: randomUUID(),
        };
        const wins = await Promise.all([
          ok("opportunities/" + deal.id + "/outcome", ta, body),
          ok("opportunities/" + deal.id + "/outcome", ta, body),
        ]);
        assert.equal(wins[0].id, wins[1].id);
        assert.equal((await ok("leads/" + leadA, ta)).outcomes.length, 1);
        deal.version = 2;
      },
    );
    await t.test(
      "ad backfill is resumable and repeatable, missing metric stays null, tenants share campaign IDs safely",
      async () => {
        const body = {
          provider: "meta",
          name: "Fictional Ads",
          accountId: "900001",
          currency: "USD",
          timezone: "UTC",
          mode: "mock",
          enabled: true,
          apiVersion: "v25.0",
          credentials: { accessToken: "fixture-only" },
        };
        connection = await ok("ad-connections", ta, body);
        await ok("ad-connections", tb, body);
        const first = await context(a, () => ads.processDue());
        assert.equal(first.state, "complete");
        assert.equal(first.rows, 30);
        await context(b, () => ads.processDue());
        await ok("ad-connections/" + connection.id + "/sync", ta, {});
        assert.equal((await context(a, () => ads.processDue())).rows, 2);
        assert.equal(
          await context(a, async () =>
            Number(
              (await tenants.db.query("SELECT count(*) FROM ad_metric_daily"))
                .rows[0].count,
            ),
          ),
          30,
        );
        assert.equal(
          (await req("ad-connections/" + connection.id + "/sync", tb, {}))
            .status,
          404,
        );
        const r = await ok(
          "reports?from=" +
            sample.occurredAt.slice(0, 10) +
            "&to=" +
            sample.occurredAt.slice(0, 10) +
            "&mode=mock",
          ta,
        );
        assert.equal(r.campaigns[0].wonToSpend, 88);
        assert.equal(r.campaigns[0].wonAmount, "1100.000000");
        await context(a, () =>
          tenants.db.query(
            "UPDATE ad_metric_daily SET spend=NULL WHERE date=$1",
            [sample.occurredAt.slice(0, 10)],
          ),
        );
        const missing = await ok(
          "reports?from=" +
            sample.occurredAt.slice(0, 10) +
            "&to=" +
            sample.occurredAt.slice(0, 10) +
            "&mode=mock",
          ta,
        );
        assert.equal(missing.campaigns[0].spend, null);
        assert.equal(missing.campaigns[0].wonToSpend, null);
        await ok("ad-connections/" + connection.id + "/sync", ta, {});
        await context(a, () => ads.processDue());
      },
    );
    await t.test(
      "source attribution handles first vs last non-direct and preserves no-source inquiries",
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        const later = inquiry({
          eventId: "later-search",
          projectId: "project-one",
          attribution: {
            provider: "organic",
            sourceKind: "website",
            occurredAt: new Date().toISOString(),
            identifiers: [],
            referrer: "https://search.example.test/",
            consentStatus: "unknown",
          },
        });
        // A later organic search must not be silently credited to the earlier paid touch.
        const result = await intake(a, later);
        assert.equal(result.body.leadId, leadA);
        const query =
          "reports?from=" +
          sample.occurredAt.slice(0, 10) +
          "&to=" +
          sample.occurredAt.slice(0, 10) +
          "&mode=mock";
        assert.equal(
          (await ok(query + "&model=first", ta)).campaigns[0].won,
          1,
        );
        assert.equal(
          (await ok(query + "&model=last_non_direct", ta)).campaigns[0].won,
          0,
        );
      },
    );
    await t.test(
      "feedback event is sent once; reopening recalculates totals without replay",
      async () => {
        const events = (await ok("feedback", ta)).items;
        const won = events.find((x) => x.kind === "won");
        const results = await Promise.all([
          ok("feedback/won/" + won.id + "/send", ta, { confirmed: true }),
          ok("feedback/won/" + won.id + "/send", ta, { confirmed: true }),
        ]);
        assert.ok(results.some((r) => r.receipt?.acceptance === "mock"));
        assert.equal(
          (
            await req("feedback/won/" + won.id + "/send", tb, {
              confirmed: true,
            })
          ).status,
          404,
        );
        await ok("feedback/qualified/" + qualified.delivery.id + "/send", ta, {
          confirmed: true,
        });
        await ok("opportunities/" + deal.id + "/outcome", ta, {
          expectedVersion: 2,
          status: "reopened",
          occurredAt: new Date().toISOString(),
          evidence: "Fictional cancellation",
          idempotencyKey: randomUUID(),
        });
        deal.version = 3;
        const report = await ok(
          "reports?from=" +
            sample.occurredAt.slice(0, 10) +
            "&to=" +
            sample.occurredAt.slice(0, 10) +
            "&mode=mock",
          ta,
        );
        assert.equal(report.summary.won, 0);
        assert.equal(
          (await ok("feedback", ta)).items.filter((x) => x.kind === "won")
            .length,
          1,
        );
        const before = await context(
          a,
          async () =>
            (await tenants.db.query("SELECT * FROM crm_feedback_attempts"))
              .rowCount,
        );
        await ok("feedback/won/" + won.id + "/send", ta, { confirmed: true });
        assert.equal(
          await context(
            a,
            async () =>
              (await tenants.db.query("SELECT * FROM crm_feedback_attempts"))
                .rowCount,
          ),
          before,
        );
      },
    );
    await t.test(
      "tenant knowledge and AI suggestions stay separate from confirmed fields",
      async () => {
        await ok("knowledge", ta, {
          title: "Tenant A only",
          body: "Fictional approved facts for tenant A.",
          source: "fixture-a",
          state: "approved",
        });
        await ok("knowledge", tb, {
          title: "Tenant B only",
          body: "Fictional approved facts for tenant B.",
          source: "fixture-b",
          state: "approved",
        });
        const before = await ok("leads/" + leadA, ta),
          suggestion = await ok("leads/" + leadA + "/ai", ta, {
            kind: "fields",
          });
        assert.equal(suggestion.provider, "mock");
        assert.equal(suggestion.applied, false);
        assert.equal(suggestion.sources.length, 1);
        assert.equal(
          (await req("leads/" + leadB + "/ai", ta, { kind: "summary" })).status,
          404,
        );
        assert.equal(
          (await ok("records/knowledge", ta)).items[0].title,
          "Tenant A only",
        );
        assert.deepEqual(
          (await ok("leads/" + leadA, ta)).lead.confirmedQualification,
          before.lead.confirmedQualification,
        );
      },
    );
    await t.test(
      "conversation channels, replies and native intake are account scoped and idempotent",
      async () => {
        await ok("channels", ta, {
          inboxId: 101,
          channel: "email",
          enabled: true,
        });
        await ok("channels", tb, {
          inboxId: 201,
          channel: "email",
          enabled: true,
        });
        assert.equal(
          (
            await req("channels", ta, {
              inboxId: 201,
              channel: "email",
              enabled: true,
            })
          ).status,
          404,
        );
        const body = {
          content: "Fictional test reply",
          private: true,
          idempotencyKey: randomUUID(),
        };
        await Promise.all([
          ok("conversations/1/messages", ta, body),
          ok("conversations/1/messages", ta, body),
        ]);
        assert.equal(cw.sent.length, 1);
        assert.equal(cw.sent[0].account, 10);
        const webhook = await ok(
          "chatwoot/" + a.slug + "/" + "a".repeat(64),
          undefined,
          { event: "message_created", id: 100, conversation: { id: 1 } },
        );
        assert.equal(webhook.state, "persisted");
        assert.equal(
          (await ok("leads/" + webhook.leadId, ta)).touches[0].provider,
          "organic",
        );
      },
    );
    await t.test(
      "invites are one-use and membership roles remain tenant scoped",
      async () => {
        const invitation = await ok("invitations", ta, {
          userId: "2",
          role: "marketing",
        });
        const join = await ok("session", undefined, {
          slug: a.slug,
          email: "viewer@example.test",
          password: "fixture-password",
          invitation: invitation.invitation,
        });
        assert.equal(join.role, "marketing");
        assert.equal(
          (
            await req("session", undefined, {
              slug: a.slug,
              email: "viewer@example.test",
              password: "fixture-password",
              invitation: invitation.invitation,
            })
          ).status,
          403,
        );
        assert.equal(
          (await ok("members", tb)).find((m) => m.user_id === "2").role,
          "viewer",
        );
      },
    );
    await t.test(
      "official ad adapter shapes: pagination, revoked token, precise costs and missing values",
      async () => {
        const c = {
            id: "fake",
            provider: "google",
            account_id: "123456",
            api_version: "v26",
            mode: "live",
          },
          calls = [];
        global.fetch = async (url, init) => {
          calls.push(JSON.parse(init.body));
          return new Response(
            JSON.stringify(
              calls.length === 1
                ? {
                    results: [
                      {
                        campaign: { id: "1", name: "Fictional" },
                        segments: { date: "2026-10-28" },
                        metrics: { costMicros: "1234567", impressions: "12" },
                      },
                    ],
                    nextPageToken: "page2",
                  }
                : { results: [] },
            ),
            { status: 200 },
          );
        };
        const rows = await context(a, () =>
          ads.readDay(
            c,
            { accessToken: "fixture", developerToken: "fixture" },
            "2026-10-28",
          ),
        );
        assert.equal(rows[0].spend, "1.234567");
        assert.equal(rows[0].clicks, null);
        assert.equal(calls[1].pageToken, "page2");
        global.fetch = async () => new Response("{}", { status: 403 });
        await assert.rejects(
          () =>
            context(a, () =>
              ads.probe(c, {
                accessToken: "fixture",
                developerToken: "fixture",
              }),
            ),
          (e) => e.code === "authorization_revoked",
        );
        global.fetch = nativeFetch;
      },
    );
    await t.test(
      "interrupted ad backfill resumes completed days without clearing prior complete data",
      async () => {
        const readDay = ads.readDay.bind(ads);
        let count = 0;
        await context(a, () =>
          tenants.db.query(
            "UPDATE ad_connections SET last_backfill_date=NULL,next_sync_at=now() WHERE id=$1",
            [connection.id],
          ),
        );
        ads.readDay = async (...args) => {
          if (++count === 2) throw new Error("fixture_interruption");
          return readDay(...args);
        };
        const interrupted = await context(a, () => ads.processDue());
        assert.equal(interrupted.state, "retrying");
        const run = await context(
          a,
          async () =>
            (
              await tenants.db.query("SELECT * FROM ad_sync_runs WHERE id=$1", [
                interrupted.id,
              ])
            ).rows[0],
        );
        assert.equal(run.cursor.completedDays.length, 1);
        ads.readDay = readDay;
        await ok("ad-connections/" + connection.id + "/sync", ta, {});
        const resumed = await context(a, () => ads.processDue());
        assert.equal(resumed.id, interrupted.id);
        assert.equal(resumed.state, "complete");
        assert.equal(resumed.rows, 30);
      },
    );
    await t.test(
      "live-shaped feedback timeout is held; known authorization rejection can be explicitly retried",
      async () => {
        await ok("integrations/feedback", ta, {
          mode: "live",
          enabled: true,
          meta: {
            accessToken: "fixture-only",
            datasetId: "999",
            graphVersion: "v25.0",
            leadEventSource: "Fictional CRM",
          },
        });
        const live = inquiry({
          eventId: "live-shaped-network",
          projectId: "live-shaped-network",
          isTest: false,
        });
        const receipt = await intake(a, live);
        const qualified = await ok(
          "leads/" + receipt.body.leadId + "/qualify",
          ta,
          {
            contactReachable: true,
            relevantNeed: true,
            targetBuyer: true,
            nextAction: "Fixture followup",
          },
        );
        let sends = 0;
        global.fetch = async (url, options) => {
          if (new URL(String(url)).hostname === "graph.facebook.com") {
            sends++;
            throw new Error("fixture secret must not leak");
          }
          return nativeFetch(url, options);
        };
        const unknown = await ok(
          "feedback/qualified/" + qualified.delivery.id + "/send",
          ta,
          { confirmed: true },
        );
        assert.equal(unknown.state, "review");
        assert.doesNotMatch(JSON.stringify(unknown), /secret/);
        await ok("feedback/qualified/" + qualified.delivery.id + "/send", ta, {
          confirmed: true,
        });
        assert.equal(sends, 1);
        assert.equal(
          (
            await req(
              "feedback/qualified/" + qualified.delivery.id + "/retry",
              ta,
              { confirmed: true, reason: "Cannot prove rejection" },
            )
          ).status,
          409,
        );
        global.fetch = nativeFetch;
        const second = await intake(
          a,
          inquiry({
            eventId: "live-shaped-rejected",
            projectId: "live-shaped-rejected",
            isTest: false,
          }),
        );
        const q = await ok("leads/" + second.body.leadId + "/qualify", ta, {
          contactReachable: true,
          relevantNeed: true,
          targetBuyer: true,
          nextAction: "Fixture followup",
        });
        global.fetch = async (url, options) =>
          new URL(String(url)).hostname === "graph.facebook.com"
            ? new Response("{}", { status: 403 })
            : nativeFetch(url, options);
        assert.equal(
          (
            await ok("feedback/qualified/" + q.delivery.id + "/send", ta, {
              confirmed: true,
            })
          ).state,
          "rejected",
        );
        global.fetch = nativeFetch;
        assert.equal(
          (
            await ok("feedback/qualified/" + q.delivery.id + "/retry", ta, {
              confirmed: true,
              reason: "Fictional credential renewed",
            })
          ).oldAttemptPreserved,
          true,
        );
        global.fetch = async (url, options) =>
          new URL(String(url)).hostname === "graph.facebook.com"
            ? new Response(
                JSON.stringify({
                  events_received: 1,
                  fbtrace_id: "fixture-receipt",
                }),
                { status: 200 },
              )
            : nativeFetch(url, options);
        const accepted = await ok(
          "feedback/qualified/" + q.delivery.id + "/send",
          ta,
          { confirmed: true },
        );
        assert.equal(accepted.receipt.acceptance, "accepted");
        assert.equal(accepted.receipt.matching, "unknown");
        global.fetch = nativeFetch;
      },
    );
    await t.test(
      "restart recovery keeps durable send intent and data; no default-tenant escape",
      async () => {
        await context(a, () =>
          tenants.db.query(
            "INSERT INTO crm_feedback_attempts(workspace_id,event_key,provider,mode,state,payload_hash,updated_at) VALUES($1,'interrupted','meta','mock','dispatching','fixture',now()-interval '3 minutes')",
            [a.workspaceId],
          ),
        );
        await context(a, () => feedback.reconcile());
        assert.equal(
          await context(
            a,
            async () =>
              (
                await tenants.db.query(
                  "SELECT state FROM crm_feedback_attempts WHERE event_key='interrupted'",
                )
              ).rows[0].state,
          ),
          "review",
        );
        assert.equal(
          (await tenants.db.query("SELECT id FROM companies")).rowCount,
          0,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM crm_quotes WHERE workspace_id=$1",
              [a.workspaceId],
            )
          ).rows[0].n,
          2,
        );
      },
    );
    await t.test(
      "actual application restart retains sessions, CRM records and send receipts",
      async () => {
        await app.get(m.REVENUE_STORE).close();
        await app.close();
        app = await m.NestFactory.create(m.AppModule, {
          rawBody: true,
          logger: false,
        });
        await app.listen(0, "127.0.0.1");
        base = await app.getUrl();
        assert.equal((await ok("session", ta)).slug, a.slug);
        assert.equal((await ok("leads/" + leadA, ta)).quotes.length, 2);
        assert.equal(
          (await ok("feedback", ta)).items.filter((x) => x.kind === "won")
            .length,
          1,
        );
        assert.equal((await req("leads/" + leadA, tb)).status, 404);
      },
    );
  } finally {
    global.fetch = nativeFetch;
    await app.get(m.REVENUE_STORE).close();
    await app.close();
    await cw.close();
    await pool.end();
  }
});
