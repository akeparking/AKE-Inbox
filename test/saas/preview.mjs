// Disposable acceptance service only. Never point this at an office database.
import assert from "node:assert/strict";
import "reflect-metadata";
import pg from "pg";
import { fakeChatwoot, modules } from "./fixtures.mjs";
assert.equal(process.env.SAAS_TEST_MODE, "true");
const url = new URL(process.env.SAAS_TEST_ADMIN_URL);
assert.equal(url.hostname, "127.0.0.1");
assert.match(url.pathname, /saas.*test/);
const cw = await fakeChatwoot(Number(process.env.SAAS_PREVIEW_CW_PORT || 14942));
const db = new pg.Pool({ connectionString: url.toString() });
await db.query("UPDATE saas_tenants SET chatwoot_url=$1 WHERE slug IN ('fixture-ake','fixture-external') AND chatwoot_account_id IN (10,20)", [cw.url]);
await db.end();
const m = modules();
const app = await m.NestFactory.create(m.AppModule, { rawBody: true, logger: ["warn", "error"] });
await app.listen(Number(process.env.SAAS_PREVIEW_PORT || 14941), "127.0.0.1");
console.log("Disposable SaaS acceptance service ready");
async function stop() { await app.get(m.REVENUE_STORE).close(); await app.close(); await cw.close(); }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
