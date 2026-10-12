-- Storage bucket settings and policies, replayed from the repo's migrations
-- in order (0005_asset_image_storage.sql, 0021_storage_scanner_writes.sql, 0025_it_documents_storage.sql, 0036_security_hardening.sql, 0039_storage_privacy.sql). The schema copy only covers app schemas,
-- so without this local photo uploads and IT documents would have no rules.
-- Regenerate if a migration changes storage: see scripts/local-db.mjs.

-- 0005_asset_image_storage.sql
insert into storage.buckets (id, name, public)
values ('asset-images', 'asset-images', true)
on conflict (id) do nothing;

drop policy if exists "public read asset images" on storage.objects;

create policy "public read asset images"
  on storage.objects for select
  using (bucket_id = 'asset-images');

drop policy if exists "auth insert asset images" on storage.objects;

create policy "auth insert asset images"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'asset-images');

drop policy if exists "auth update asset images" on storage.objects;

create policy "auth update asset images"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'asset-images');

drop policy if exists "auth delete asset images" on storage.objects;

create policy "auth delete asset images"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'asset-images');

-- 0021_storage_scanner_writes.sql
drop policy if exists "auth insert asset images" on storage.objects;

create policy "scanner insert asset images"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'asset-images'
    and (public.is_super_admin() or public.is_allowed_scanner())
  );

drop policy if exists "auth update asset images" on storage.objects;

create policy "scanner update asset images"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'asset-images'
    and (public.is_super_admin() or public.is_allowed_scanner())
  )
  with check (
    bucket_id = 'asset-images'
    and (public.is_super_admin() or public.is_allowed_scanner())
  );

drop policy if exists "auth delete asset images" on storage.objects;

create policy "scanner delete asset images"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'asset-images'
    and (public.is_super_admin() or public.is_allowed_scanner())
  );

-- 0025_it_documents_storage.sql
insert into storage.buckets (id, name, public)
values ('it-documents', 'it-documents', true)
on conflict (id) do nothing;

drop policy if exists "public read it documents" on storage.objects;

create policy "public read it documents"
  on storage.objects for select
  using (bucket_id = 'it-documents');

drop policy if exists "admin insert it documents" on storage.objects;

create policy "admin insert it documents"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'it-documents' and public.is_admin());

drop policy if exists "admin update it documents" on storage.objects;

create policy "admin update it documents"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'it-documents' and public.is_admin());

drop policy if exists "admin delete it documents" on storage.objects;

create policy "admin delete it documents"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'it-documents' and public.is_admin());

-- 0036_security_hardening.sql
drop policy if exists "public read asset images" on storage.objects;

drop policy if exists "signed-in read asset images" on storage.objects;

create policy "signed-in read asset images"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'asset-images');

drop policy if exists "public read it documents" on storage.objects;

drop policy if exists "admin read it documents" on storage.objects;

create policy "admin read it documents"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'it-documents' and public.is_admin());

-- 0039_storage_privacy.sql
update storage.buckets
   set public = false
 where id = 'it-documents';

update storage.buckets
   set file_size_limit = 10485760,   
       allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif']
 where id = 'asset-images';

update storage.buckets
   set file_size_limit = 26214400,   
       allowed_mime_types = array[
         'application/pdf',
         'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.ms-excel',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'text/csv',
         'text/plain',
         'image/jpeg',
         'image/png'
       ]
 where id = 'it-documents';

drop policy if exists "admin read it documents" on storage.objects;

create policy "admin read it documents"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'it-documents' and public.is_admin());
