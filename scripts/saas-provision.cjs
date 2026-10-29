const { Pool } = require("pg");
const { randomUUID, randomBytes, createHmac } = require("node:crypto");
const { FieldCipher } = require("../apps/revenue-core/dist/common/crypto");
const { readFile, writeFile } = require("node:fs/promises");
const { z } = require("zod");
const schema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  chatwootAccountId: z.number().int().positive(),
  chatwootUrl: z.url(),
  adminUserId: z.string().regex(/^\d+$/),
  effectiveFrom: z.iso.datetime(),
  template: z.enum(["general-b2b", "ake-parking"]).default("general-b2b"),
  timezone: z.string().default("UTC"),
  enabled: z.boolean().default(false),
});
async function main() {
  if (
    !process.env.SAAS_PROVISION_DATABASE_URL ||
    !process.env.FIELD_ENCRYPTION_KEY
  )
    throw new Error("Provisioning configuration required");
  const input = schema.parse(
      JSON.parse(await readFile(process.argv[2], "utf8")),
    ),
    output = process.argv[3];
  if (!output) throw new Error("Private receipt output path required");
  const origin = new URL(input.chatwootUrl);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error("HTTPS Chatwoot origin required");
  new Intl.DateTimeFormat("en", { timeZone: input.timezone });
  const pool = new Pool({
      connectionString: process.env.SAAS_PROVISION_DATABASE_URL,
    }),
    workspaceId = "workspace_" + randomUUID(),
    intakeSecret = randomBytes(32).toString("hex"),
    chatwootWebhookToken = randomBytes(32).toString("hex");
  const cipher = new FieldCipher(
    createHmac("sha256", process.env.FIELD_ENCRYPTION_KEY)
      .update("saas:" + workspaceId)
      .digest("hex"),
  );
  const receipt = {
    workspaceId,
    slug: input.slug,
    intakeSecret,
    chatwootWebhookToken,
    enabled: input.enabled,
  };
  // Reserve receipt path without overwriting operator material; failed DB write removes no originals.
  await writeFile(
    output,
    JSON.stringify({ ...receipt, state: "provisioning" }, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("INSERT INTO workspaces(id,name) VALUES($1,$2)", [
      workspaceId,
      input.name,
    ]);
    await db.query(
      "INSERT INTO saas_tenants(workspace_id,slug,chatwoot_account_id,chatwoot_url,enabled,effective_from,settings,secrets) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        workspaceId,
        input.slug,
        input.chatwootAccountId,
        origin.origin,
        input.enabled,
        input.effectiveFrom,
        {
          template: input.template,
          timezone: input.timezone,
          feedbackMode: "mock",
          monthlyInquiryLimit: 10000,
          monthlyAiLimit: 1000,
          adAccountLimit: 10,
        },
        cipher.encrypt(
          JSON.stringify({
            intakeSecret,
            chatwootWebhookToken,
            model: { provider: "mock" },
          }),
        ),
      ],
    );
    await db.query(
      "INSERT INTO saas_members(workspace_id,user_id,role) VALUES($1,$2,'admin')",
      [workspaceId, input.adminUserId],
    );
    await db.query("COMMIT");
    await writeFile(
      output,
      JSON.stringify({ ...receipt, state: "provisioned" }, null, 2),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        workspaceId,
        slug: input.slug,
        enabled: input.enabled,
        state: "provisioned",
        privateReceiptWritten: true,
      }),
    );
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    "Provisioning failed. Check input, unique organization/account mapping and private receipt state.",
  );
  process.exitCode = 1;
});
