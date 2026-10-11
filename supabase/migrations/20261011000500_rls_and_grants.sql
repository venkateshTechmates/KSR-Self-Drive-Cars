-- Row-level security on every table (ADM-04, 9.2). Roles are enforced here, not only in the UI.
-- Writes that carry business rules go through security-definer functions; tables only allow
-- direct writes where the permission matrix (2.2) allows plain edits.

do $$
declare
  t text;
begin
  foreach t in array array[
    'staff_profiles', 'user_roles', 'settings', 'policy_versions', 'cars', 'car_photos', 'car_price_history',
    'maintenance_windows', 'customers', 'booking_code_counters', 'consents', 'bookings', 'booking_events',
    'document_types', 'upload_links', 'documents', 'handover_records', 'booking_charges', 'payments',
    'service_logs', 'data_requests', 'audit_logs', 'submission_attempts', 'login_attempts', 'account_locks',
    'outbox', 'document_reminders'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$$;

-- ------------------------------------------------------------------ staff & roles
create policy staff_profiles_select on public.staff_profiles for select to authenticated
  using ((select public.is_admin_user()) or user_id = (select auth.uid()));
create policy staff_profiles_owner_update on public.staff_profiles for update to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

create policy user_roles_select on public.user_roles for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_owner_or_manager()));
-- Role changes go through the admin-staff edge function (Owner only).

-- ------------------------------------------------------------------ settings & policies
create policy settings_select on public.settings for select to authenticated
  using ((select public.is_admin_user()));
create policy settings_owner_insert on public.settings for insert to authenticated
  with check ((select public.is_owner()));
create policy settings_owner_update on public.settings for update to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

create policy policy_versions_select on public.policy_versions for select to authenticated
  using ((select public.is_admin_user()));
-- Versioned: new versions are inserted, old ones are never edited (SET-03).
create policy policy_versions_owner_insert on public.policy_versions for insert to authenticated
  with check ((select public.is_owner()));

create policy document_types_select on public.document_types for select to authenticated
  using ((select public.is_admin_user()));
create policy document_types_owner_insert on public.document_types for insert to authenticated
  with check ((select public.is_owner()));
create policy document_types_owner_update on public.document_types for update to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

-- ------------------------------------------------------------------ fleet
create policy cars_select on public.cars for select to authenticated
  using ((select public.is_admin_user()));
create policy cars_om_insert on public.cars for insert to authenticated
  with check ((select public.is_owner_or_manager()));
create policy cars_om_update on public.cars for update to authenticated
  using ((select public.is_owner_or_manager())) with check ((select public.is_owner_or_manager()));
create policy cars_owner_delete on public.cars for delete to authenticated
  using ((select public.is_owner()));

create policy car_photos_select on public.car_photos for select to authenticated
  using ((select public.is_admin_user()));
create policy car_photos_om_write on public.car_photos for all to authenticated
  using ((select public.is_owner_or_manager())) with check ((select public.is_owner_or_manager()));

create policy car_price_history_select on public.car_price_history for select to authenticated
  using ((select public.is_owner_or_manager()));

create policy maintenance_select on public.maintenance_windows for select to authenticated
  using ((select public.is_admin_user()));
create policy maintenance_om_write on public.maintenance_windows for all to authenticated
  using ((select public.is_owner_or_manager())) with check ((select public.is_owner_or_manager()));

create policy service_logs_om on public.service_logs for all to authenticated
  using ((select public.is_owner_or_manager())) with check ((select public.is_owner_or_manager()));

-- ------------------------------------------------------------------ customers (staff: today only, AC-10)
create policy customers_select on public.customers for select to authenticated
  using (
    (select public.is_owner_or_manager())
    or ((select public.my_role()) = 'staff' and public.customer_has_booking_today(id))
  );
create policy customers_om_insert on public.customers for insert to authenticated
  with check ((select public.is_owner_or_manager()));
create policy customers_om_update on public.customers for update to authenticated
  using ((select public.is_owner_or_manager())) with check ((select public.is_owner_or_manager()));

create policy consents_select on public.consents for select to authenticated
  using ((select public.is_owner_or_manager()));

-- ------------------------------------------------------------------ bookings (staff: today ± 1 day)
create policy bookings_select on public.bookings for select to authenticated
  using (
    (select public.is_owner_or_manager())
    or ((select public.my_role()) = 'staff' and public.staff_can_see_booking(pickup_at, return_due_at, status))
  );

create policy booking_events_select on public.booking_events for select to authenticated
  using (public.can_see_booking(booking_id));
create policy handover_records_select on public.handover_records for select to authenticated
  using (public.can_see_booking(booking_id));
create policy booking_charges_select on public.booking_charges for select to authenticated
  using (public.can_see_booking(booking_id));
create policy payments_select on public.payments for select to authenticated
  using (public.can_see_booking(booking_id));

-- ------------------------------------------------------------------ documents
create policy documents_select on public.documents for select to authenticated
  using (public.can_view_document(documents));

create policy upload_links_select on public.upload_links for select to authenticated
  using ((select public.is_owner_or_manager()));

-- ------------------------------------------------------------------ privacy & audit
create policy data_requests_om on public.data_requests for all to authenticated
  using ((select public.is_owner_or_manager())) with check ((select public.is_owner_or_manager()));

-- AUD-03: read-only, Owner only.
create policy audit_logs_owner_select on public.audit_logs for select to authenticated
  using ((select public.is_owner()));

create policy outbox_owner_select on public.outbox for select to authenticated
  using ((select public.is_owner()));

-- booking_code_counters, submission_attempts, login_attempts, account_locks and
-- document_reminders have no policies: only service_role and definer functions touch them.

-- ------------------------------------------------------------------ public views (9.2)
-- Visitors read only these. No registration numbers, internal notes or personal data.
create view public.public_cars
with (security_invoker = false)
as
select
  c.id, c.slug, c.display_name, c.brand, c.model, c.body_type, c.category, c.seats, c.fuel, c.transmission,
  c.badge, c.description, c.price_12h_paise, c.price_24h_paise, c.sort_order,
  coalesce((
    select jsonb_agg(
      jsonb_build_object('id', p.id, 'path', p.storage_path, 'alt', p.alt_text, 'width', p.width, 'height', p.height)
      order by (p.id = c.cover_photo_id) desc, p.sort_order, p.created_at
    )
    from public.car_photos p where p.car_id = c.id
  ), '[]'::jsonb) as photos
from public.cars c
where c.status = 'active';

create view public.public_settings
with (security_invoker = false)
as
select s.key, s.value
from public.settings s
where s.key in ('business', 'booking_rules');

create view public.public_policies
with (security_invoker = false)
as
select distinct on (p.kind, p.locale)
  p.kind, p.locale, p.version, p.title, p.body_md, p.published_at,
  p.kind::text || '-' || p.locale || '-v' || p.version as label
from public.policy_versions p
order by p.kind, p.locale, p.version desc;

-- ------------------------------------------------------------------ grants
revoke all on all tables in schema public from anon;
grant select on public.public_cars, public.public_settings, public.public_policies to anon, authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- Functions RLS policies call, plus pure helpers.
grant execute on function
  public.ist_date(timestamptz), public.ist_today(), public.ist_day_start(date), public.ist_minutes(timestamptz),
  public.fmt_clock(integer), public.fmt_when(timestamptz), public.fmt_rupees(bigint),
  public.normalize_phone(text), public.normalize_dl(text), public.is_modern_dl(text), public.mask_number(text),
  public.my_role(), public.my_role_unchecked(), public.mfa_required(public.app_role), public.has_role(uuid, public.app_role),
  public.is_owner(), public.is_owner_or_manager(), public.is_admin_user(),
  public.in_staff_window(timestamptz), public.staff_can_see_booking(timestamptz, timestamptz, public.booking_status),
  public.customer_has_booking_today(uuid), public.can_see_booking(uuid),
  public.can_view_document(public.documents), public.can_download_document(public.documents),
  public.request_header(text), public.request_ip()
to authenticated;

-- Admin RPCs (each checks the caller's role itself).
grant execute on function
  public.my_access(),
  public.log_client_event(text, text, text, jsonb),
  public.current_notice_version(text),
  public.car_clashes(uuid, timestamptz, timestamptz, uuid),
  public.car_paper_problems(uuid, timestamptz),
  public.admin_create_booking(uuid, public.booking_package, timestamptz, text, text, text, public.booking_source, boolean, text, integer, integer, text, text, integer),
  public.booking_transition(uuid, public.booking_status, text, text),
  public.pickup_gate_problems(uuid),
  public.record_handover(uuid, public.handover_kind, integer, public.fuel_level, jsonb, text, uuid, text),
  public.update_booking(uuid, uuid, public.booking_package, integer, timestamptz, integer, text, integer, integer, text),
  public.extend_booking(uuid, text, integer, integer, text),
  public.add_booking_charge(uuid, public.charge_kind, integer, text, uuid),
  public.remove_booking_charge(uuid, text),
  public.record_payment(uuid, integer, public.payment_type, public.payment_method, text, text, uuid, timestamptz),
  public.set_booking_hold(uuid, boolean, text),
  public.report_utilisation(timestamptz, timestamptz),
  public.can_upload_document(public.doc_owner_type, uuid, text),
  public.verify_document(uuid, public.doc_status, public.verification_method, text, date, text),
  public.update_document_details(uuid, date, date, text, text),
  public.soft_delete_document(uuid, text),
  public.restore_document(uuid),
  public.set_document_hold(uuid, boolean, text),
  public.document_duplicates(text),
  public.verify_customer_identity(uuid, public.identity_method, text, boolean, uuid),
  public.clear_customer_identity(uuid, text),
  public.set_customer_block(uuid, boolean, text),
  public.export_customer_data(uuid),
  public.erasure_blockers(uuid),
  public.erase_customer(uuid, text),
  public.merge_customers(uuid, uuid, text)
to authenticated;

-- Public RPCs (no personal data; lookup is rate-limited).
grant execute on function
  public.public_busy_windows(timestamptz, timestamptz),
  public.lookup_booking(text, text)
to anon, authenticated;

-- New functions are not executable by default.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
