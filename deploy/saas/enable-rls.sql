-- Run as migration owner on the isolated SaaS database, never on an existing office database.
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='workspace_id'
    AND table_name NOT IN ('saas_tenants','saas_members','saas_sessions','saas_invitations','saas_login_attempts') LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',r.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_boundary ON %I',r.table_name);
    EXECUTE format('CREATE POLICY tenant_boundary ON %I USING (workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')) WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'',true),''''))',r.table_name);
  END LOOP;
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='account_id' AND (table_name LIKE 'inbox_v2_%%' OR table_name LIKE 'marketing_%%') LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',r.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_account_boundary ON %I',r.table_name);
    EXECUTE format('CREATE POLICY tenant_account_boundary ON %I AS %s USING (account_id = nullif(current_setting(''app.account_id'',true),'''')::bigint) WITH CHECK (account_id = nullif(current_setting(''app.account_id'',true),'''')::bigint)',r.table_name,
      CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=r.table_name AND column_name='workspace_id') THEN 'RESTRICTIVE' ELSE 'PERMISSIVE' END);
  END LOOP;
END $$;
