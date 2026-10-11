-- Storage layout (6.8.3).
--   car-photos: public read-only; cars/{car_id}/{photo_id}.webp (+ -800 / -400 variants)
--   documents:  private; customers/…, bookings/…, vehicles/…, business/…
-- The documents bucket has no policies at all: files are written and read only by edge
-- functions (service role), which check the caller's role and log every access (DOC-05, DOC-07).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('car-photos', 'car-photos', true, 10485760, array['image/webp']),
  ('documents', 'documents', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "ksr car-photos select" on storage.objects for select to authenticated
  using (bucket_id = 'car-photos' and (select public.is_owner_or_manager()));
create policy "ksr car-photos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'car-photos' and (select public.is_owner_or_manager()));
create policy "ksr car-photos update" on storage.objects for update to authenticated
  using (bucket_id = 'car-photos' and (select public.is_owner_or_manager()))
  with check (bucket_id = 'car-photos' and (select public.is_owner_or_manager()));
create policy "ksr car-photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'car-photos' and (select public.is_owner_or_manager()));
