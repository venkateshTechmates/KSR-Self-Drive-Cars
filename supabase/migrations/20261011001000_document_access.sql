-- What the signed-in user may do with one document. Used by document-view-url, which runs
-- this with the caller's own JWT so the answer reflects their role and staff scope.
create or replace function public.document_access(p_doc uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  d public.documents;
  t public.document_types;
begin
  select * into d from public.documents where id = p_doc;
  if not found or not public.can_view_document(d) then
    return jsonb_build_object('can_view', false, 'can_download', false);
  end if;
  select * into t from public.document_types where key = d.doc_type;
  return jsonb_build_object(
    'can_view', true,
    'can_download', public.can_download_document(d),
    'is_kyc', t.is_kyc,
    'label', t.label,
    'storage_path', d.storage_path,
    'original_filename', d.original_filename,
    'mime_type', d.mime_type,
    'deleted', d.deleted_at is not null
  );
end;
$$;

revoke execute on function public.document_access(uuid) from public, anon;
grant execute on function public.document_access(uuid) to authenticated, service_role;
