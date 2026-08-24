-- ============================================================
-- HARD RESET: admin_verify_user
-- Drops every existing overload of admin_verify_user (regardless
-- of its parameter names/types), recreates it clean, grants it,
-- and forces PostgREST to reload its schema cache immediately.
-- Safe to re-run any time.
-- ============================================================

do $$
declare
  r record;
begin
  for r in
    select oid::regprocedure as sig
    from pg_proc
    where proname = 'admin_verify_user'
      and pronamespace = 'public'::regnamespace
  loop
    execute format('drop function %s', r.sig);
  end loop;
end $$;

create function public.admin_verify_user(target_user_id uuid, make_verified boolean, p_verification_type text default 'purple')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if make_verified and p_verification_type not in ('blue', 'gold', 'purple') then
    raise exception 'invalid verification_type: %', p_verification_type;
  end if;
  update public.profiles
    set verified = make_verified,
        verification_type = case when make_verified then p_verification_type else null end
    where id = target_user_id;
end;
$$;

grant execute on function public.admin_verify_user(uuid, boolean, text) to authenticated;

notify pgrst, 'reload schema';
