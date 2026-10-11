-- Document centre (6.8), customers (6.7), privacy rights (10.3) and retention (10.4).

-- ------------------------------------------------------------------ visibility
create or replace function public.can_view_document(p_doc public.documents)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role := public.my_role();
  t public.document_types;
begin
  if v_role is null then
    return false;
  end if;
  if p_doc.deleted_at is not null and v_role <> 'owner' then
    return false;
  end if;
  select * into t from public.document_types where key = p_doc.doc_type;
  if not found or not (v_role = any (t.view_roles)) then
    return false;
  end if;
  if v_role = 'staff' then
    return case p_doc.owner_type
      when 'customer' then public.customer_has_booking_today(p_doc.customer_id)
      when 'booking' then exists (
        select 1 from public.bookings b
         where b.id = p_doc.booking_id and public.staff_can_see_booking(b.pickup_at, b.return_due_at, b.status)
      )
      else false
    end;
  end if;
  return true;
end;
$$;

-- Staff may view KYC documents but never download them (2.2).
create or replace function public.can_download_document(p_doc public.documents)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role := public.my_role();
  t public.document_types;
begin
  if not public.can_view_document(p_doc) then
    return false;
  end if;
  select * into t from public.document_types where key = p_doc.doc_type;
  if v_role = 'staff' and t.is_kyc then
    return false;
  end if;
  return v_role = any (t.download_roles);
end;
$$;

-- Used by the document-upload edge function, with the caller's identity.
create or replace function public.can_upload_document(p_owner_type public.doc_owner_type, p_owner_id uuid, p_doc_type text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role := public.my_role();
  t public.document_types;
begin
  if v_role is null then
    return false;
  end if;
  select * into t from public.document_types where key = p_doc_type and active;
  if not found or t.owner_type <> p_owner_type or not (v_role = any (t.view_roles)) then
    return false;
  end if;
  return case p_owner_type
    when 'customer' then exists (select 1 from public.customers where id = p_owner_id and erased_at is null)
      and (v_role <> 'staff' or public.customer_has_booking_today(p_owner_id))
    when 'booking' then public.can_see_booking(p_owner_id)
    when 'car' then v_role in ('owner', 'manager') and exists (select 1 from public.cars where id = p_owner_id)
    when 'business' then v_role = 'owner'
  end;
end;
$$;

-- ------------------------------------------------------------------ register an uploaded file
-- Called by the document-upload and customer-upload edge functions (service role) after the
-- file has been checked and stored. Handles versioning (DOC-11) and the audit entry (DOC-07).
create or replace function public._register_document(
  p_actor uuid,
  p_owner_type public.doc_owner_type,
  p_owner_id uuid,
  p_doc_type text,
  p_storage_path text,
  p_original_filename text,
  p_mime text,
  p_size integer,
  p_sha256 text,
  p_doc_number text default null,
  p_issue date default null,
  p_expiry date default null,
  p_notes text default '',
  p_replaces uuid default null,
  p_aadhaar_masked_confirmed boolean default false,
  p_uploaded_via public.upload_channel default 'admin',
  p_upload_link uuid default null,
  p_context_booking uuid default null,
  p_ip text default null,
  p_user_agent text default null
)
returns public.documents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t public.document_types;
  v_old public.documents;
  v_doc public.documents;
  v_status public.doc_status;
begin
  select * into t from public.document_types where key = p_doc_type and active;
  if not found or t.owner_type <> p_owner_type then
    raise exception using message = 'Choose a document type that fits.', detail = 'doc_type';
  end if;
  if p_owner_type <> 'business' and p_owner_id is null then
    raise exception using message = 'Choose what this document belongs to.', detail = 'owner';
  end if;
  -- DOC-10: never store an unmasked Aadhaar.
  if p_doc_type = 'aadhaar_masked' and not coalesce(p_aadhaar_masked_confirmed, false) then
    raise exception using message = 'Confirm that only the last 4 digits of the Aadhaar number are visible.', detail = 'aadhaar_mask';
  end if;
  if p_doc_number is not null and regexp_replace(p_doc_number, '[[:space:]-]', '', 'g') ~ '^[0-9]{12}$' and p_doc_type in ('aadhaar_masked', 'other_photo_id') then
    raise exception using message = 'Don''t enter a full Aadhaar number. Leave the number blank.', detail = 'doc_number';
  end if;
  if t.expiry_required and p_expiry is null then
    raise exception using message = 'Enter the expiry date.', detail = 'expiry_date';
  end if;
  if p_issue is not null and p_expiry is not null and p_expiry < p_issue then
    raise exception using message = 'The expiry date is before the issue date.', detail = 'expiry_date';
  end if;

  if p_replaces is not null then
    select * into v_old from public.documents where id = p_replaces for update;
    if not found or v_old.deleted_at is not null or v_old.status = 'superseded'
       or v_old.doc_type <> p_doc_type or v_old.owner_type <> p_owner_type
       or v_old.owner_id is distinct from (case when p_owner_type = 'business' then null else p_owner_id end) then
      raise exception using message = 'The document being replaced doesn''t match.', detail = 'replaces';
    end if;
    update public.documents set status = 'superseded' where id = v_old.id;
  end if;

  v_status := case
    when t.tracks_expiry and p_expiry is not null and p_expiry < public.ist_today() then 'expired'
    when t.is_kyc then 'pending'
    else 'verified'
  end;

  insert into public.documents (
    owner_type, customer_id, booking_id, car_id, doc_type, storage_path, original_filename, mime_type, size_bytes,
    sha256, doc_number_masked, issue_date, expiry_date, notes, status, version, replaces_id,
    aadhaar_masked_confirmed, uploaded_by, uploaded_via, upload_link_id
  )
  values (
    p_owner_type,
    case when p_owner_type = 'customer' then p_owner_id end,
    case when p_owner_type = 'booking' then p_owner_id when p_owner_type = 'customer' then p_context_booking end,
    case when p_owner_type = 'car' then p_owner_id end,
    p_doc_type, p_storage_path, left(p_original_filename, 255), p_mime, p_size, p_sha256,
    public.mask_number(p_doc_number), p_issue, p_expiry, coalesce(p_notes, ''), v_status,
    coalesce(v_old.version, 0) + 1, p_replaces,
    coalesce(p_aadhaar_masked_confirmed, false), p_actor, p_uploaded_via, p_upload_link
  )
  returning * into v_doc;

  perform public.write_audit(
    case when p_replaces is null then 'document.upload' else 'document.replace' end,
    'documents', v_doc.id::text, null,
    jsonb_build_object('doc_type', p_doc_type, 'owner_type', p_owner_type, 'owner_id', p_owner_id,
                       'version', v_doc.version, 'replaces', p_replaces, 'uploaded_via', p_uploaded_via,
                       'size_bytes', p_size, 'mime_type', p_mime),
    p_actor, p_ip, p_user_agent
  );
  return v_doc;
end;
$$;

-- View/download log entries (DOC-07, AC-08), written by document-view-url.
create or replace function public._log_document_access(p_doc uuid, p_action text, p_actor uuid, p_ip text, p_user_agent text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.write_audit(p_action, 'documents', p_doc::text, null,
    (select jsonb_build_object('doc_type', d.doc_type, 'owner_type', d.owner_type, 'owner_id', d.owner_id)
       from public.documents d where d.id = p_doc),
    p_actor, p_ip, p_user_agent)
$$;

-- ------------------------------------------------------------------ verify, edit, delete, hold
create or replace function public.verify_document(
  p_doc uuid,
  p_status public.doc_status,
  p_method public.verification_method default null,
  p_reason text default null,
  p_expiry_date date default null,
  p_doc_number text default null
)
returns public.documents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.documents;
  t public.document_types;
  v_expiry date;
begin
  select * into d from public.documents where id = p_doc for update;
  if not found or not public.can_view_document(d) or d.deleted_at is not null then
    raise exception using message = 'Document not found.', detail = 'not_found';
  end if;
  select * into t from public.document_types where key = d.doc_type;
  if not t.is_kyc then
    raise exception using message = 'Only customer ID documents need verification.', detail = 'invalid';
  end if;
  if d.status = 'superseded' then
    raise exception using message = 'This is an old version. Verify the current one.', detail = 'state';
  end if;
  v_expiry := coalesce(p_expiry_date, d.expiry_date);

  if p_status = 'verified' then
    if p_method is null then
      raise exception using message = 'Choose how you verified it.', detail = 'method';
    end if;
    if d.doc_type = 'dl_front' and v_expiry is null then
      raise exception using message = 'Enter the licence expiry date.', detail = 'expiry_date';
    end if;
    if v_expiry is not null and v_expiry < public.ist_today() then
      raise exception using message = 'This document has expired. Reject it, or upload a current one.', detail = 'expiry_date';
    end if;
  elsif p_status = 'rejected' then
    if coalesce(trim(p_reason), '') = '' then
      raise exception using message = 'Give a reason for rejecting it.', detail = 'reason';
    end if;
  else
    raise exception using message = 'Mark the document Verified or Rejected.', detail = 'invalid';
  end if;

  update public.documents
     set status = p_status,
         verification_method = case when p_status = 'verified' then p_method end,
         verified_by = auth.uid(),
         verified_at = now(),
         reject_reason = case when p_status = 'rejected' then trim(p_reason) end,
         expiry_date = v_expiry,
         doc_number_masked = coalesce(public.mask_number(p_doc_number), doc_number_masked)
   where id = d.id
   returning * into d;

  if d.doc_type = 'dl_front' and p_status = 'verified' and d.customer_id is not null then
    update public.customers
       set dl_expiry = v_expiry,
           dl_number = coalesce(public.normalize_dl(p_doc_number), dl_number)
     where id = d.customer_id;
  end if;

  perform public.write_audit(
    case when p_status = 'verified' then 'document.verify' else 'document.reject' end,
    'documents', d.id::text, null,
    jsonb_build_object('doc_type', d.doc_type, 'method', p_method, 'reason', p_reason, 'expiry_date', v_expiry)
  );
  return d;
end;
$$;

create or replace function public.update_document_details(
  p_doc uuid,
  p_issue_date date default null,
  p_expiry_date date default null,
  p_notes text default null,
  p_doc_number text default null
)
returns public.documents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.documents;
  v_before jsonb;
begin
  select * into d from public.documents where id = p_doc for update;
  if not found or not public.can_view_document(d) or d.deleted_at is not null then
    raise exception using message = 'Document not found.', detail = 'not_found';
  end if;
  if public.my_role() = 'staff' and d.owner_type <> 'customer' then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  v_before := jsonb_build_object('issue_date', d.issue_date, 'expiry_date', d.expiry_date, 'notes', d.notes);
  update public.documents
     set issue_date = coalesce(p_issue_date, issue_date),
         expiry_date = coalesce(p_expiry_date, expiry_date),
         notes = coalesce(p_notes, notes),
         doc_number_masked = coalesce(public.mask_number(p_doc_number), doc_number_masked),
         status = case
           when status in ('pending', 'verified') and coalesce(p_expiry_date, expiry_date) < public.ist_today() then 'expired'
           when status = 'expired' and coalesce(p_expiry_date, expiry_date) >= public.ist_today()
             then case when (select is_kyc from public.document_types where key = doc_type) then 'pending' else 'verified' end
           else status
         end::public.doc_status
   where id = d.id
   returning * into d;
  perform public.write_audit('document.update', 'documents', d.id::text, v_before,
    jsonb_build_object('issue_date', d.issue_date, 'expiry_date', d.expiry_date, 'notes', d.notes));
  return d;
end;
$$;

-- DOC-15: Owner only, soft delete with a reason; erased permanently after the grace period.
create or replace function public.soft_delete_document(p_doc uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.documents;
begin
  if not public.is_owner() then
    raise exception using message = 'Only the Owner can delete documents.', detail = 'forbidden';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception using message = 'Give a reason for deleting it.', detail = 'reason';
  end if;
  update public.documents
     set deleted_at = now(),
         deleted_by = auth.uid(),
         delete_reason = trim(p_reason),
         retain_until = now() + make_interval(days => public.retention_setting('soft_delete_days', 30))
   where id = p_doc and deleted_at is null
   returning * into d;
  if d.id is null then
    raise exception using message = 'Document not found.', detail = 'not_found';
  end if;
  perform public.write_audit('document.delete', 'documents', d.id::text, null,
    jsonb_build_object('doc_type', d.doc_type, 'reason', p_reason, 'erase_after', d.retain_until));
end;
$$;

create or replace function public.restore_document(p_doc uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.documents;
begin
  if not public.is_owner() then
    raise exception using message = 'Only the Owner can restore documents.', detail = 'forbidden';
  end if;
  update public.documents
     set deleted_at = null, deleted_by = null, delete_reason = null, retain_until = null
   where id = p_doc and deleted_at is not null
   returning * into d;
  if d.id is null then
    raise exception using message = 'Document not found, or already erased.', detail = 'not_found';
  end if;
  perform public.write_audit('document.restore', 'documents', d.id::text, null, jsonb_build_object('doc_type', d.doc_type));
end;
$$;

create or replace function public.set_document_hold(p_doc uuid, p_hold boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_owner_or_manager() then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  if p_hold and coalesce(trim(p_reason), '') = '' then
    raise exception using message = 'Give a reason for the hold.', detail = 'reason';
  end if;
  update public.documents set legal_hold = p_hold, hold_reason = case when p_hold then trim(p_reason) end where id = p_doc;
  perform public.write_audit(case when p_hold then 'document.hold' else 'document.release' end, 'documents', p_doc::text, null,
    jsonb_build_object('reason', p_reason));
end;
$$;

-- Duplicate check by SHA-256 fingerprint (DOC-04), limited to what the caller can see.
create or replace function public.document_duplicates(p_sha256 text)
returns table (id uuid, doc_type text, owner_type public.doc_owner_type, owner_id uuid, created_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.doc_type, d.owner_type, d.owner_id, d.created_at
    from public.documents d
   where d.sha256 = lower(p_sha256) and d.deleted_at is null and public.can_view_document(d)
   order by d.created_at desc
   limit 10
$$;

-- ------------------------------------------------------------------ customers
-- AAD-02/AAD-04: record how identity was checked at pickup. Only the last 4 Aadhaar digits are kept.
create or replace function public.verify_customer_identity(
  p_customer uuid,
  p_method public.identity_method,
  p_aadhaar_last4 text default null,
  p_consent boolean default false,
  p_booking uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role := public.my_role();
  v_last4 text := nullif(trim(coalesce(p_aadhaar_last4, '')), '');
begin
  if v_role is null or not exists (select 1 from public.customers where id = p_customer and erased_at is null)
     or (v_role = 'staff' and not public.customer_has_booking_today(p_customer)) then
    raise exception using message = 'Customer not found.', detail = 'not_found';
  end if;
  if p_method is null then
    raise exception using message = 'Choose how you verified their identity.', detail = 'method';
  end if;
  if v_last4 is not null and v_last4 !~ '^[0-9]{4}$' then
    raise exception using message = 'Enter only the last 4 digits of the Aadhaar number.', detail = 'aadhaar_last4';
  end if;
  if p_method in ('aadhaar_qr', 'aadhaar_original_seen') then
    if v_last4 is null then
      raise exception using message = 'Enter the last 4 digits of the Aadhaar number.', detail = 'aadhaar_last4';
    end if;
    if not coalesce(p_consent, false) then
      raise exception using message = 'The customer must agree before you verify their Aadhaar.', detail = 'consent';
    end if;
    insert into public.consents (customer_id, booking_id, purpose, notice_version, channel, ip, user_agent, recorded_by)
    values (p_customer, p_booking, 'aadhaar_verification', public.current_notice_version(), 'admin',
            public.request_ip(), left(public.request_header('user-agent'), 400), auth.uid());
  end if;
  update public.customers
     set identity_verified = true,
         identity_method = p_method,
         identity_verified_by = auth.uid(),
         identity_verified_at = now(),
         aadhaar_last4 = case when p_method in ('aadhaar_qr', 'aadhaar_original_seen') then v_last4 else aadhaar_last4 end
   where id = p_customer;
end;
$$;

create or replace function public.clear_customer_identity(p_customer uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_owner_or_manager() then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception using message = 'Give a reason.', detail = 'reason';
  end if;
  update public.customers
     set identity_verified = false, identity_method = null, identity_verified_by = null, identity_verified_at = null
   where id = p_customer;
  perform public.write_audit('customer.identity_cleared', 'customers', p_customer::text, null, jsonb_build_object('reason', p_reason));
end;
$$;

-- CUS-04 blocklist.
create or replace function public.set_customer_block(p_customer uuid, p_blocked boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_owner_or_manager() then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  if p_blocked and coalesce(trim(p_reason), '') = '' then
    raise exception using message = 'Give a reason for blocking this customer.', detail = 'reason';
  end if;
  update public.customers
     set blocked = p_blocked, block_reason = case when p_blocked then trim(p_reason) end
   where id = p_customer;
  if not found then
    raise exception using message = 'Customer not found.', detail = 'not_found';
  end if;
end;
$$;

-- CUS-06 / DP-05: export everything held about a customer (no files, no document numbers).
create or replace function public.export_customer_data(p_customer uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_out jsonb;
begin
  if not public.is_owner_or_manager() then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  select jsonb_build_object(
    'exported_at', now(),
    'customer', to_jsonb(c) - 'notes',
    'bookings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', b.booking_code, 'status', b.status, 'car', car.display_name, 'package', b.package,
        'pickup_at', b.pickup_at, 'return_due_at', b.return_due_at, 'actual_pickup_at', b.actual_pickup_at,
        'actual_return_at', b.actual_return_at, 'total_paise', b.total_paise, 'paid_paise', b.paid_paise
      ) order by b.pickup_at)
      from public.bookings b join public.cars car on car.id = b.car_id where b.customer_id = c.id), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('booking', b.booking_code, 'amount_paise', p.amount_paise, 'type', p.type,
                                          'method', p.method, 'received_at', p.received_at) order by p.received_at)
      from public.payments p join public.bookings b on b.id = p.booking_id where b.customer_id = c.id), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object('type', dt.label, 'status', d.status, 'uploaded_at', d.created_at,
                                          'expiry_date', d.expiry_date) order by d.created_at)
      from public.documents d join public.document_types dt on dt.key = d.doc_type
      where d.customer_id = c.id and d.deleted_at is null), '[]'::jsonb),
    'consents', coalesce((
      select jsonb_agg(jsonb_build_object('purpose', cs.purpose, 'notice_version', cs.notice_version,
                                          'granted_at', cs.granted_at, 'withdrawn_at', cs.withdrawn_at) order by cs.granted_at)
      from public.consents cs where cs.customer_id = c.id), '[]'::jsonb)
  ) into v_out
  from public.customers c where c.id = p_customer;
  if v_out is null then
    raise exception using message = 'Customer not found.', detail = 'not_found';
  end if;
  perform public.write_audit('customer.export', 'customers', p_customer::text, null, null);
  return v_out;
end;
$$;

-- Reasons erasure must wait (DP-05): open bookings, unsettled money, holds.
create or replace function public.erasure_blockers(p_customer uuid)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select array_remove(array[
    case when exists (select 1 from public.bookings where customer_id = p_customer and status in ('requested', 'confirmed', 'active', 'returned'))
         then 'The customer has a booking that is still open.' end,
    case when exists (select 1 from public.bookings where customer_id = p_customer
                      and (total_paise - paid_paise <> 0 or deposit_received_paise - deposit_refunded_paise <> 0)
                      and status not in ('rejected', 'cancelled'))
         then 'A payment, refund or deposit is not settled.' end,
    case when exists (select 1 from public.bookings where customer_id = p_customer and on_hold)
         then 'A booking is on hold for a fine, claim or dispute.' end,
    case when exists (select 1 from public.documents where customer_id = p_customer and legal_hold)
         then 'A document is on hold.' end
  ], null)
$$;

-- Erase a customer's personal data. Booking and payment records stay for accounts, but are
-- no longer linked to a name or number. Files are erased by the retention-purge job.
create or replace function public.erase_customer(p_customer uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_blockers text[];
  v_docs integer;
begin
  if not public.is_owner() then
    raise exception using message = 'Only the Owner can erase customer data.', detail = 'forbidden';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception using message = 'Give a reason.', detail = 'reason';
  end if;
  v_blockers := public.erasure_blockers(p_customer);
  if cardinality(v_blockers) > 0 then
    raise exception using message = array_to_string(v_blockers, ' '), detail = 'erasure_blocked', hint = to_jsonb(v_blockers)::text;
  end if;

  perform set_config('ksr.skip_row_audit', 'on', true);

  update public.documents
     set deleted_at = now(), deleted_by = auth.uid(), delete_reason = 'Customer erasure: ' || trim(p_reason), retain_until = now()
   where deleted_at is null
     and (customer_id = p_customer
          or booking_id in (select id from public.bookings where customer_id = p_customer))
     and doc_type in (select key from public.document_types where is_kyc or key in ('signature', 'pickup_photos', 'return_photos'));
  get diagnostics v_docs = row_count;

  update public.customers
     set full_name = 'Erased customer', phone = null, email = null, dl_number = null, dl_expiry = null,
         aadhaar_last4 = null, identity_verified = false, identity_method = null, identity_verified_by = null,
         identity_verified_at = null, notes = '', erased_at = now()
   where id = p_customer;
  update public.consents set withdrawn_at = coalesce(withdrawn_at, now()), ip = null, user_agent = null where customer_id = p_customer;
  delete from public.upload_links where customer_id = p_customer;

  perform set_config('ksr.skip_row_audit', 'off', true);
  perform public.write_audit('customer.erase', 'customers', p_customer::text, null,
    jsonb_build_object('reason', p_reason, 'documents_queued_for_erasure', v_docs));
  return jsonb_build_object('ok', true, 'documents_queued', v_docs);
end;
$$;

-- CUS-05: merge two customer records, keeping all bookings and documents.
create or replace function public.merge_customers(p_keep uuid, p_merge uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  k public.customers;
  m public.customers;
begin
  if not public.is_owner() then
    raise exception using message = 'Only the Owner can merge customers.', detail = 'forbidden';
  end if;
  if p_keep = p_merge then
    raise exception using message = 'Choose two different customers.', detail = 'invalid';
  end if;
  select * into k from public.customers where id = p_keep for update;
  select * into m from public.customers where id = p_merge for update;
  if k.id is null or m.id is null then
    raise exception using message = 'Customer not found.', detail = 'not_found';
  end if;
  update public.bookings set customer_id = k.id where customer_id = m.id;
  update public.documents set customer_id = k.id where customer_id = m.id;
  update public.consents set customer_id = k.id where customer_id = m.id;
  update public.upload_links set customer_id = k.id where customer_id = m.id;
  update public.data_requests set customer_id = k.id where customer_id = m.id;
  delete from public.customers where id = m.id;
  update public.customers
     set email = coalesce(k.email, m.email),
         dl_number = coalesce(k.dl_number, m.dl_number),
         dl_expiry = coalesce(k.dl_expiry, m.dl_expiry),
         aadhaar_last4 = coalesce(k.aadhaar_last4, m.aadhaar_last4),
         blocked = k.blocked or m.blocked,
         block_reason = coalesce(k.block_reason, m.block_reason),
         notes = concat_ws(E'\n', nullif(k.notes, ''), nullif(m.notes, ''), 'Merged with ' || coalesce(m.phone, 'erased record') || ': ' || p_reason)
   where id = k.id;
  perform public.write_audit('customer.merge', 'customers', k.id::text,
    jsonb_build_object('merged_id', m.id, 'merged_phone', m.phone), jsonb_build_object('reason', p_reason));
end;
$$;

-- ------------------------------------------------------------------ scheduled jobs
-- Daily 08:00 IST: mark expired documents (DOC-12, P0 part of expiry-reminders).
create or replace function public.mark_expired_documents()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  update public.documents d
     set status = 'expired'
    from public.document_types t
   where t.key = d.doc_type
     and t.tracks_expiry
     and d.deleted_at is null
     and d.status in ('pending', 'verified')
     and d.expiry_date < public.ist_today();
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public.write_audit('documents.mark_expired', 'documents', null, null, jsonb_build_object('count', v_n));
  end if;
  return v_n;
end;
$$;

-- DOC-13: email reminders 30, 15, 7 and 1 day(s) before vehicle papers expire, and on the day.
create or replace function public.queue_expiry_reminders()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_n integer := 0;
  v_recipients text[] := public._recipients('expiry_emails');
begin
  for r in
    select d.id, d.expiry_date, dt.label, c.display_name, c.registration_number, (d.expiry_date - public.ist_today()) as days_left
      from public.documents d
      join public.document_types dt on dt.key = d.doc_type
      join public.cars c on c.id = d.car_id
     where d.owner_type = 'car'
       and dt.tracks_expiry
       and d.deleted_at is null
       and d.status not in ('superseded', 'rejected')
       and (d.expiry_date - public.ist_today()) in (30, 15, 7, 1, 0)
       and not exists (select 1 from public.document_reminders x where x.document_id = d.id and x.days_before = (d.expiry_date - public.ist_today()))
  loop
    perform public._enqueue_email(
      'expiry_reminder',
      v_recipients,
      case when r.days_left = 0 then r.label || ' expires today – ' || r.display_name
           else r.label || ' expires in ' || r.days_left || ' day' || case when r.days_left = 1 then '' else 's' end || ' – ' || r.display_name end,
      concat_ws(E'\n',
        r.label || ' for ' || r.display_name || coalesce(' (' || r.registration_number || ')', '') || ' expires on ' || to_char(r.expiry_date, 'FMDD Mon YYYY') || '.',
        'Upload the renewed document before it expires. Bookings for this car can''t be confirmed with expired insurance, PUC or permit.'),
      jsonb_build_object('document_id', r.id, 'path', '/admin/documents?doc=' || r.id),
      'expiry:' || r.id || ':' || r.days_left
    );
    insert into public.document_reminders (document_id, days_before) values (r.id, r.days_left) on conflict do nothing;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Section 11: overdue return alert.
create or replace function public.queue_overdue_alerts()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_n integer := 0;
  v_grace integer := public.booking_rule('late_grace_minutes', 30)::integer;
begin
  for r in
    select b.id, b.booking_code, b.return_due_at, c.display_name, cu.full_name, cu.phone
      from public.bookings b
      join public.cars c on c.id = b.car_id
      join public.customers cu on cu.id = b.customer_id
     where b.status = 'active'
       and b.return_due_at + make_interval(mins => v_grace) < now()
       and b.overdue_notified_at is null
  loop
    perform public._enqueue_email(
      'overdue',
      public._recipients('overdue_emails'),
      'Overdue return ' || r.booking_code || ' – ' || r.display_name,
      concat_ws(E'\n',
        r.display_name || ' (' || r.booking_code || ') was due back at ' || public.fmt_when(r.return_due_at) || '.',
        'Customer: ' || r.full_name || ', ' || coalesce(r.phone, '')),
      jsonb_build_object('booking_code', r.booking_code, 'path', '/admin/bookings/' || r.booking_code),
      'overdue:' || r.id
    );
    update public.bookings set overdue_notified_at = now() where id = r.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- 10.4: work out when each document may be erased, from its type's retention rule.
create or replace function public.compute_document_retention()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  with calc as (
    select d.id,
      case
        when t.retention_days is null or t.retention_basis = 'none' then null
        when t.retention_basis = 'booking_end' then (
          select b.ended_at + make_interval(days => t.retention_days)
            from public.bookings b where b.id = d.booking_id and b.status in ('rejected', 'cancelled', 'no_show', 'closed'))
        when t.retention_basis = 'customer_last_booking_end' then
          case
            when exists (select 1 from public.bookings b where b.customer_id = d.customer_id
                         and b.status not in ('rejected', 'cancelled', 'no_show', 'closed')) then null
            else coalesce(
              (select max(b.ended_at) from public.bookings b where b.customer_id = d.customer_id),
              d.created_at
            ) + make_interval(days => t.retention_days)
          end
      end as until
      from public.documents d
      join public.document_types t on t.key = d.doc_type
     where d.deleted_at is null
  )
  update public.documents d
     set retain_until = calc.until
    from calc
   where calc.id = d.id and d.retain_until is distinct from calc.until;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Documents whose time is up and that are not on hold.
create or replace function public._retention_due(p_limit integer default 200)
returns table (id uuid, storage_path text, reason text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.storage_path, case when d.deleted_at is not null then 'deleted' else 'retention' end
    from public.documents d
   where d.retain_until is not null
     and d.retain_until <= now()
     and not d.legal_hold
     and not exists (select 1 from public.bookings b where b.id = d.booking_id and b.on_hold)
     and not exists (select 1 from public.bookings b where b.customer_id = d.customer_id and b.on_hold)
   order by d.retain_until
   limit p_limit
$$;

-- Remove the row once the file is gone; the audit entry records the erasure (AC-12).
create or replace function public._erase_document(p_doc uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.documents;
begin
  delete from public.documents where id = p_doc returning * into d;
  if d.id is not null then
    perform public.write_audit('document.erase', 'documents', d.id::text, null,
      jsonb_build_object('doc_type', d.doc_type, 'owner_type', d.owner_type, 'owner_id', d.owner_id, 'reason', p_reason));
  end if;
end;
$$;

-- Erase stale requests, orphan customers, old logs and system rows (10.4).
create or replace function public._purge_stale_records()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requests_days integer := public.retention_setting('requests_days', 90);
  v_audit_days integer := greatest(
    public.retention_setting('audit_days', 365),
    coalesce((select max(retention_days) from public.document_types), 0) + public.retention_setting('soft_delete_days', 30)
  );
  v_bookings integer;
  v_customers integer;
  v_audit integer;
begin
  perform set_config('ksr.skip_row_audit', 'on', true);

  delete from public.submission_attempts where at < now() - interval '2 days';
  delete from public.login_attempts where at < now() - interval '30 days';
  delete from public.account_locks where locked_until < now() - interval '1 day';
  delete from public.upload_links where expires_at < now() - interval '7 days';
  delete from public.outbox where status in ('sent', 'skipped') and created_at < now() - interval '30 days';

  delete from public.bookings b
   where (b.status in ('requested', 'rejected') or (b.status = 'cancelled' and b.actual_pickup_at is null))
     and coalesce(b.ended_at, b.pickup_at, b.created_at) < now() - make_interval(days => v_requests_days)
     and not b.on_hold
     and not exists (select 1 from public.payments p where p.booking_id = b.id)
     and not exists (select 1 from public.documents d where d.booking_id = b.id)
     and not exists (select 1 from public.booking_charges ch where ch.booking_id = b.id);
  get diagnostics v_bookings = row_count;

  delete from public.customers c
   where not c.blocked
     and c.created_at < now() - make_interval(days => v_requests_days)
     and not exists (select 1 from public.bookings b where b.customer_id = c.id)
     and not exists (select 1 from public.documents d where d.customer_id = c.id)
     and not exists (select 1 from public.data_requests r where r.customer_id = c.id and r.status in ('open', 'in_progress'));
  get diagnostics v_customers = row_count;

  perform set_config('ksr.audit_purge', 'on', true);
  delete from public.audit_logs where at < now() - make_interval(days => v_audit_days);
  get diagnostics v_audit = row_count;
  perform set_config('ksr.audit_purge', 'off', true);
  perform set_config('ksr.skip_row_audit', 'off', true);

  if v_bookings + v_customers + v_audit > 0 then
    perform public.write_audit('retention.purge', 'system', null, null,
      jsonb_build_object('requests', v_bookings, 'customers', v_customers, 'audit_entries', v_audit));
  end if;
  return jsonb_build_object('requests', v_bookings, 'customers', v_customers, 'audit_entries', v_audit);
end;
$$;
