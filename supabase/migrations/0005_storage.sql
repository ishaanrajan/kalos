-- =============================================================================
-- 0005_storage.sql
-- Storage buckets + object policies.
--
-- Object key layout (enforced by the policies below):
--     photos/{user_id}/{uuid}.jpg
--     avatars/{user_id}/{uuid}.jpg
--
-- Both buckets are public-read so <Image source={{ uri }} /> can load them
-- without a signed URL. Writes are scoped to the uploader's own folder.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('photos',  'photos',  true, 10485760, array['image/jpeg','image/png','image/webp']),
  ('avatars', 'avatars', true,  5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- storage.objects is owned by supabase_storage_admin. The `postgres` role used
-- by the SQL editor and by `supabase db push` is allowed to manage policies on
-- it; on a locked-down instance this block degrades to a NOTICE and you can
-- recreate the same four policies from Dashboard -> Storage -> Policies.
do $$
begin
  drop policy if exists "kalos public read"   on storage.objects;
  drop policy if exists "kalos insert own"    on storage.objects;
  drop policy if exists "kalos update own"    on storage.objects;
  drop policy if exists "kalos delete own"    on storage.objects;

  create policy "kalos public read"
    on storage.objects for select
    to public
    using (bucket_id in ('photos', 'avatars'));

  create policy "kalos insert own"
    on storage.objects for insert
    to authenticated
    with check (
      bucket_id in ('photos', 'avatars')
      and (storage.foldername(name))[1] = (select auth.uid())::text
    );

  create policy "kalos update own"
    on storage.objects for update
    to authenticated
    using (
      bucket_id in ('photos', 'avatars')
      and (storage.foldername(name))[1] = (select auth.uid())::text
    )
    with check (
      bucket_id in ('photos', 'avatars')
      and (storage.foldername(name))[1] = (select auth.uid())::text
    );

  create policy "kalos delete own"
    on storage.objects for delete
    to authenticated
    using (
      bucket_id in ('photos', 'avatars')
      and (storage.foldername(name))[1] = (select auth.uid())::text
    );
exception
  when insufficient_privilege then
    raise notice 'Could not manage policies on storage.objects (insufficient privilege). Create them from the Supabase dashboard instead -- see supabase/README.md.';
end
$$;
