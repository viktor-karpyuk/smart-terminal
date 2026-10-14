'use strict';
(async () => {
  const $ = (id) => document.getElementById(id);
  const info = await fetch('/api/providers').then((r) => r.json()).catch(() => ({ providers: [] }));
  if (info.orgName) $('org').textContent = info.orgName;
  for (const p of info.providers ?? []) {
    const a = document.createElement('a');
    a.className = 'button sso';
    a.href = `/auth/${encodeURIComponent(p.id)}/start`;
    a.textContent = `Continue with ${p.label}`;
    $('providers').append(a);
  }
  $('or').hidden = !(info.providers ?? []).length;
  $('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('error').textContent = '';
    const data = Object.fromEntries(new FormData(event.target));
    const res = await fetch('/api/web/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) location.href = '/';
    else $('error').textContent = body.error || 'Could not sign in.';
  });
})();
