-- Scheduled jobs (9.3) with pg_cron. Edge functions are called through pg_net using two
-- Vault secrets you create once per project (see README, "Scheduled jobs"):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'ksr_project_url');
--   select vault.create_secret('<same value as the CRON_SECRET function secret>', 'ksr_cron_secret');

create or replace function public._call_edge_function(p_name text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url text;
  v_secret text;
  v_id bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'ksr_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'ksr_cron_secret';
  if v_url is null or v_secret is null then
    raise notice 'Vault secrets ksr_project_url and ksr_cron_secret are not set; skipping %.', p_name;
    return null;
  end if;
  execute 'select net.http_post(url := $1, headers := $2, body := $3)'
    into v_id
    using rtrim(v_url, '/') || '/functions/v1/' || p_name,
          jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
          '{}'::jsonb;
  return v_id;
end;
$$;

revoke execute on function public._call_edge_function(text) from public, anon, authenticated;

do $outer$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'pg_cron / pg_net are not available here; schedule the jobs manually (README).';
    return;
  end if;

  create extension if not exists pg_cron;
  create extension if not exists pg_net;

  -- Drain the email outbox every minute when something is waiting (Section 11).
  execute $sql$select cron.schedule('ksr-notify', '* * * * *',
    $job$select public._call_edge_function('notify') where exists (select 1 from public.outbox where status = 'pending')$job$)$sql$;

  -- 08:00 IST: mark expired documents, queue expiry reminders (DOC-12, DOC-13).
  execute $sql$select cron.schedule('ksr-document-expiry', '30 2 * * *',
    $job$select public.mark_expired_documents(); select public.queue_expiry_reminders();$job$)$sql$;

  -- Every 15 minutes: overdue return alerts.
  execute $sql$select cron.schedule('ksr-overdue', '*/15 * * * *', $job$select public.queue_overdue_alerts();$job$)$sql$;

  -- 03:00 IST: work out retention dates, then erase what is due (DOC-15, 10.4).
  execute $sql$select cron.schedule('ksr-retention', '30 21 * * *',
    $job$select public.compute_document_retention(); select public._call_edge_function('retention-purge');$job$)$sql$;
end;
$outer$;
