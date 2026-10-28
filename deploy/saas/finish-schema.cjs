const { Pool } = require("pg");
const { readFileSync } = require("node:fs");
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      readFileSync(process.env.SAAS_RLS_FILE || "/app/enable-rls.sql", "utf8"),
    );
    await pool.query(
      "REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO saas_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO saas_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO saas_runtime; REVOKE ALL ON schema_migrations FROM saas_runtime",
    );
    console.log("SaaS tenant policies installed");
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error("SaaS schema finalization failed");
  process.exitCode = 1;
});
