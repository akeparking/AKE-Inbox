import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { createHash } from 'node:crypto';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl });
  const directory = join(__dirname, "migrations");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const retryableCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "57P03"]);

  try {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      try {
        const client=await pool.connect();
        try{
          await client.query('BEGIN');
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ake-schema-migrations',0))");
          await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
          for(const name of files){
            const sql=await readFile(join(directory,name),'utf8'),checksum=createHash('sha256').update(sql).digest('hex');
            const previous=(await client.query('SELECT checksum FROM schema_migrations WHERE name=$1',[name])).rows[0];
            if(previous){if(previous.checksum!==checksum)throw new Error('Applied migration checksum changed: '+name);continue;}
            await client.query(sql);await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,checksum]);
          }
          await client.query('COMMIT');
        }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
        process.stdout.write("Database migration complete\n");
        return;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (!retryableCodes.has(code) || attempt === 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
