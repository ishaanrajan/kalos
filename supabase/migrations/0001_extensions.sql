-- =============================================================================
-- 0001_extensions.sql
-- Extensions required by Kalos.
--
-- Idempotent. Run first.
-- =============================================================================

-- Supabase ships an `extensions` schema and keeps it on the database-level
-- search_path. Create it defensively so this file also runs on a vanilla
-- Postgres instance.
create schema if not exists extensions;

-- citext: case-insensitive text, used for profiles.username so that
-- "Ishaan" and "ishaan" can never both be registered.
create extension if not exists citext with schema extensions;

-- pgcrypto is not strictly required (gen_random_uuid() is built into
-- pg_catalog on PG13+) but we create it so gen_random_uuid() resolves on
-- older instances too.
create extension if not exists pgcrypto with schema extensions;

-- Make sure the extension schema is reachable for plain sessions. Functions in
-- later migrations pin `search_path = public, extensions` explicitly, so they
-- do not depend on this.
do $$
begin
  execute format(
    'alter database %I set search_path to "$user", public, extensions',
    current_database()
  );
exception
  when others then
    raise notice 'Skipping ALTER DATABASE search_path (%). Not required: every function below pins its own search_path.', sqlerrm;
end
$$;

grant usage on schema extensions to authenticated, anon, service_role;
