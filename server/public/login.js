'use strict';
(async () => {
  const $ = (id) => document.getElementById(id);
  const info = await fetch('/api/providers').then((r) => r.json()).catch(() => ({ providers: [] }));
  if (info.orgName) {
    $('org').textContent = info.orgName;
    $('mark').textContent = info.orgName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    document.title = `Sign in · ${info.orgName}`;
  }
  for (const p of info.providers ?? []) {
    const a = document.createElement('a');
    a.className = 'button';
    a.href = `/auth/${encodeURIComponent(p.id)}/start`;
    a.textContent = `Continue with ${p.label}`;
    $('providers').append(a);
  }
  $('or').hidden = !(info.providers ?? []).length;
  $('providers').hidden = !(info.providers ?? []).length;
  $('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button');
    $('error').textContent = '';
    button.disabled = true;
    const data = Object.fromEntries(new FormData(event.target));
    const res = await fetch('/api/web/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) { location.href = '/'; return; }
    $('error').textContent = body.error || 'Could not sign in.';
    button.disabled = false;
  });
})();
