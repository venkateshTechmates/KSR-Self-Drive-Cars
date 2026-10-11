-- Login lockout (ADM-06) and login audit (AUD-01) through Supabase Auth's
-- "password verification attempt" hook. Enable it in supabase/config.toml (local) or in
-- Dashboard > Authentication > Hooks (hosted), pointing at this function.

create or replace function public.hook_password_verification_attempt(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := (event ->> 'user_id')::uuid;
  v_valid boolean := coalesce((event ->> 'valid')::boolean, false);
  v_locked timestamptz;
  v_fails integer;
  v_email text;
  v_owners text[];
  v_reject jsonb := jsonb_build_object(
    'decision', 'reject',
    'message', 'Too many failed attempts. Try again in 15 minutes.',
    'should_logout_user', true
  );
begin
  select locked_until into v_locked from public.account_locks where user_id = v_user;
  if v_locked is not null and v_locked > now() then
    perform public.write_audit('auth.login_blocked', 'auth', v_user::text, null, null, v_user);
    return v_reject;
  end if;

  insert into public.login_attempts (user_id, succeeded) values (v_user, v_valid);

  if v_valid then
    delete from public.account_locks where user_id = v_user;
    update public.staff_profiles set last_seen_at = now() where user_id = v_user;
    perform public.write_audit('auth.login', 'auth', v_user::text, null, null, v_user);
    return jsonb_build_object('decision', 'continue');
  end if;

  perform public.write_audit('auth.login_failed', 'auth', v_user::text, null, null, v_user);

  select count(*) into v_fails
    from public.login_attempts
   where user_id = v_user
     and not succeeded
     and at > now() - interval '15 minutes'
     and at > coalesce((select max(at) from public.login_attempts where user_id = v_user and succeeded), '-infinity'::timestamptz);

  if v_fails >= 5 then
    insert into public.account_locks (user_id, locked_until)
    values (v_user, now() + interval '15 minutes')
    on conflict (user_id) do update set locked_until = excluded.locked_until;

    select email into v_email from auth.users where id = v_user;
    v_owners := coalesce(
      nullif(array(select jsonb_array_elements_text(public.setting('notifications') -> 'lockout_emails')), '{}'::text[]),
      array(select sp.email from public.staff_profiles sp join public.user_roles ur on ur.user_id = sp.user_id
             where ur.role = 'owner' and sp.active)
    );
    perform public._enqueue_email(
      'lockout', v_owners,
      'Admin account locked: ' || coalesce(v_email, v_user::text),
      'The admin account ' || coalesce(v_email, v_user::text) || ' was locked for 15 minutes after 5 failed sign-in attempts at '
        || public.fmt_when(now()) || '. If this wasn''t them, deactivate the account in Staff.',
      jsonb_build_object('user_id', v_user, 'path', '/admin/staff'),
      'lockout:' || v_user || ':' || to_char(now(), 'YYYYMMDDHH24MI')
    );
    return v_reject;
  end if;

  return jsonb_build_object('decision', 'continue');
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_password_verification_attempt(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_password_verification_attempt(jsonb) from public, anon, authenticated;

-- One-time setup: make an existing Auth user the first Owner (ADM-02: no public sign-up).
-- Run in the SQL editor: select public.bootstrap_owner('owner@example.com', 'Owner name');
create or replace function public.bootstrap_owner(p_email text, p_full_name text default 'Owner')
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid;
begin
  if exists (select 1 from public.user_roles where role = 'owner') then
    raise exception 'An Owner already exists. Add more staff from /admin/staff.';
  end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'No user with that email. Create the user first (Authentication > Users > Add user), then run this again.';
  end if;
  insert into public.staff_profiles (user_id, full_name, email)
  values (v_user, p_full_name, lower(trim(p_email)))
  on conflict (user_id) do update set active = true, full_name = excluded.full_name;
  insert into public.user_roles (user_id, role)
  values (v_user, 'owner')
  on conflict (user_id) do update set role = 'owner';
  return 'Owner set: ' || p_email;
end;
$$;

revoke execute on function public.bootstrap_owner(text, text) from public, anon, authenticated;
