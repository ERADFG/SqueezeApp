// ─────────────────────────────────────────────────────────────
// PROFILE LISTS PAGE — /<username>/lists
// Reached from a profile's "···" menu ("View Lists" — see
// profileMenuItemsHtml() in profile.js). Shows every List that
// profile is a member of *and that the current viewer is allowed to
// see* — RLS on public.lists already hides another owner's private
// Lists from anyone but that owner (see supabase/lists.sql), so this
// page never has to duplicate that check client-side.
// Also reachable via the legacy profilelists.html?u=<username> form,
// same fallback pattern as followlist.js.
// ─────────────────────────────────────────────────────────────
const plUsername = (() => {
  const m = location.pathname.match(/^\/([^/]+)\/lists\/?$/);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(location.search).get('u');
})();

async function loadProfileLists() {
  const root = document.getElementById('profilelists-root');
  if (!plUsername) {
    root.innerHTML = `<div class="errmsg">No user specified.</div>`;
    return;
  }

  const { data: profile, error } = await sb.from('profiles').select('*').ilike('username', plUsername).single();
  if (error || !profile) {
    root.innerHTML = `<div class="errmsg">No user found with that username.</div>`;
    return;
  }
  document.title = `Lists @${profile.username} is on — InteractInk`;
  document.getElementById('pl-name').textContent = 'Lists';
  document.getElementById('pl-handle').textContent = `@${profile.username}`;
  document.getElementById('pl-back').href = profileUrl(profile.username);
  const canonical = profileListsUrl(profile.username);
  if (location.pathname + location.search !== canonical) { try { history.replaceState(null, '', canonical); } catch (e) {} }
  setPageDescription(`Lists @${profile.username} is a member of, on InteractInk.`);
  setCanonical(canonical);

  const { data: memberRows, error: memErr } = await sb.from('list_members')
    .select('list_id').eq('member_id', profile.id);
  if (memErr) { root.innerHTML = `<div class="errmsg">${esc(memErr.message)}</div>`; return; }
  const listIds = [...new Set((memberRows || []).map(r => r.list_id))];
  if (!listIds.length) {
    root.innerHTML = `<div class="empty-note">@${esc(profile.username)} isn't on any Lists you can see.</div>`;
    return;
  }

  const { data: lists, error: listsErr } = await sb.from('lists').select('*').in('id', listIds).order('created_at', { ascending: false });
  if (listsErr) { root.innerHTML = `<div class="errmsg">${esc(listsErr.message)}</div>`; return; }
  if (!lists.length) {
    root.innerHTML = `<div class="empty-note">@${esc(profile.username)} isn't on any Lists you can see.</div>`;
    return;
  }

  const ownerIds = [...new Set(lists.map(l => l.owner_id))];
  const { data: owners } = await sb.from('profiles').select('id,username,display_name').in('id', ownerIds);
  const ownerById = new Map((owners || []).map(o => [o.id, o]));

  root.innerHTML = `<div class="list-list">` +
    lists.map(l => listRowHtml(l, ownerById.get(l.owner_id))).join('') +
    `</div>`;
}

document.addEventListener('DOMContentLoaded', async () => {
  await authReady; // see auth.js — private-list visibility depends on who's logged in
  loadProfileLists();
});
