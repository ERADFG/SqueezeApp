-- ============================================================
-- LIMIT: max 2 communities per account (creator)
-- ============================================================
-- The client already checks this before opening the create-community
-- wizard and again right before submitting it (see
-- openCreateCommunityModal()/submitCreateCommunityWizard() in
-- js/common.js), but that alone is a UX nicety, not real enforcement
-- — anyone could bypass it and insert a 3rd row directly. This
-- trigger is the actual limit.
--
-- Run this once in the Supabase SQL editor. Safe to re-run.
-- ============================================================

create or replace function public.enforce_community_owner_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.communities where created_by = new.created_by) >= 2 then
    raise exception 'You can only create up to 2 communities.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_community_owner_limit on public.communities;
create trigger trg_community_owner_limit
  before insert on public.communities
  for each row execute function public.enforce_community_owner_limit();
