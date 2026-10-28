/* Self-hosted adapter: gives the planner a server-backed store and a Google Calendar bridge */
(function () {
  async function api(method, url, body) {
    let r;
    try { r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); }
    catch (e) { throw { code: 'server_unavailable', message: 'Can\'t reach the planner server.', retryable: true }; }
    if (r.status === 401) { location.href = '/login'; throw { code: 'unauthenticated', message: 'Sign in again.' }; }
    const j = (r.headers.get('content-type') || '').includes('json') ? await r.json().catch(() => null) : null;
    if (!r.ok) throw Object.assign({ code: 'upstream_error', message: 'Server error ' + r.status }, j && j.error);
    return j;
  }

  /* ---- store ---- */
  let state = { trips: {}, items: {} };
  const tripL = new Set(), itemL = new Map(), placeL = new Set();
  const placeList = () => Object.entries(state.places || {}).map(([id, v]) => ({ id, ...v }));
  const emit = () => {
    const trips = Object.entries(state.trips).map(([id, v]) => ({ id, ...v }));
    tripL.forEach(f => f(trips));
    placeL.forEach(f => f(placeList()));
    itemL.forEach((set, t) => { const a = Object.entries(state.items[t] || {}).map(([id, v]) => ({ id, ...v })); set.forEach(f => f(a)); });
  };
  let last = '', gen = 0, pending = 0;
  // a poll that started before a local change must not overwrite it with older server data
  async function refresh(force) {
    const g = gen;
    try {
      const s = await api('GET', '/api/state');
      if (!force && (g !== gen || pending)) return;
      const sig = JSON.stringify(s); if (sig !== last) { last = sig; state = s; emit(); }
    } catch (e) {}
  }
  setInterval(() => { if (!document.hidden) refresh(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  const local = fn => { fn(); last = JSON.stringify(state); emit(); };
  // show the change straight away, then save it; if saving fails, reload the server's copy
  async function op(mutate, call) {
    gen++; pending++;
    try { local(mutate); } catch (e) {}
    try { await call(); }
    catch (e) { pending--; last = ''; await refresh(true); throw e; }
    pending--;
  }
  const store = {
    mode: 'server',
    newId: () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 20) : Math.random().toString(36).slice(2) + Date.now().toString(36)),
    subTrips(cb) { tripL.add(cb); refresh(true).then(() => cb(Object.entries(state.trips).map(([id, v]) => ({ id, ...v })))); return () => tripL.delete(cb); },
    subItems(t, cb) { if (!itemL.has(t)) itemL.set(t, new Set()); itemL.get(t).add(cb); setTimeout(() => cb(Object.entries(state.items[t] || {}).map(([id, v]) => ({ id, ...v })))); return () => itemL.get(t).delete(cb); },
    setTrip: (id, d) => op(() => { state.trips[id] = d; }, () => api('PUT', '/api/trips/' + id, d)),
    patchTrip: (id, d) => op(() => { state.trips[id] = { ...state.trips[id], ...d }; }, () => api('PATCH', '/api/trips/' + id, d)),
    delTrip: id => op(() => { delete state.trips[id]; delete state.items[id]; }, () => api('DELETE', '/api/trips/' + id)),
    setItem: (t, id, d) => op(() => { (state.items[t] = state.items[t] || {})[id] = d; }, () => api('PUT', `/api/trips/${t}/items/${id}`, d)),
    patchItem: (t, id, d) => op(() => { (state.items[t] = state.items[t] || {})[id] = { ...state.items[t][id], ...d }; }, () => api('PATCH', `/api/trips/${t}/items/${id}`, d)),
    delItem: (t, id) => op(() => { if (state.items[t]) delete state.items[t][id]; }, () => api('DELETE', `/api/trips/${t}/items/${id}`)),
    subPlaces(cb) { placeL.add(cb); setTimeout(() => cb(placeList())); return () => placeL.delete(cb); },
    setPlace: (id, d) => op(() => { (state.places = state.places || {})[id] = d; }, () => api('PUT', '/api/places/' + id, d)),
    delPlace: id => op(() => { if (state.places) delete state.places[id]; }, () => api('DELETE', '/api/places/' + id)),
    async importPlaces(list) { const r = await api('POST', '/api/places/import', { places: list }); await refresh(true); return r; }
  };

  /* ---- Google Calendar bridge (same call shape the planner uses on claude.ai) ---- */
  const watches = new Set();
  const callTool = (server, tool, input) => api('POST', '/api/gcal/' + tool, input || {}).then(j => ({ content: [], payload: j.payload }));
  const mcp = {
    callTool,
    watchTool(server, tool, input, handler, opts) {
      const w = { run: () => callTool(server, tool, input).then(r => handler({ type: 'data', result: r }), e => handler({ type: 'error', error: e })) };
      watches.add(w); setTimeout(w.run);
      const iv = setInterval(() => { if (!document.hidden) w.run(); }, (opts && opts.refetchInterval) || 300000);
      return () => { clearInterval(iv); watches.delete(w); };
    },
    invalidate() { watches.forEach(w => w.run()); return Promise.resolve(); },
    listTools: async () => ({ servers: [] })
  };

  /* ---- settings ---- */
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let S = null, people = null, tab = 'account', mapCfg = null;
  const loadSettings = async () => { S = await api('GET', '/api/settings'); return S; };
  loadSettings().catch(() => {});
  const toast = msg => { document.querySelectorAll('.toast').forEach(x => x.remove()); const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); el.textContent = msg; document.body.appendChild(el); setTimeout(() => el.remove(), 3400); };
  const root = () => document.getElementById('modalRoot');
  const close = () => { root().innerHTML = ''; };
  const errText = e => (e && e.message) || 'Something went wrong. Try again.';

  async function openSettings(which) {
    tab = which || tab;
    try { await loadSettings(); if (S.user.admin && !people) people = (await api('GET', '/api/users')).users; } catch (e) { toast(errText(e)); return; }
    render();
  }
  function render() {
    const tabs = [['account', 'Account'], ['google', 'Google Calendar']].concat(S.user.admin ? [['map', 'Map'], ['people', 'People']] : []);
    root().innerHTML = `<div class="scrim" id="setScrim"><div class="modal" role="dialog" aria-modal="true" aria-label="Settings" style="width:min(640px,100%);gap:16px">
      <div style="display:flex;align-items:center;gap:12px"><h3 style="flex:1">Settings</h3><button class="icon-btn" id="setClose" aria-label="Close settings"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg></button></div>
      <div class="seg" role="tablist" style="align-self:flex-start">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-pressed="${tab === k}">${l}</button>`).join('')}</div>
      <div id="setBody" style="display:flex;flex-direction:column;gap:14px">${tab === 'google' ? googleHTML() : tab === 'map' ? mapHTML() : tab === 'people' ? peopleHTML() : accountHTML()}</div></div></div>`;
    const m = root().querySelector('.modal');
    root().querySelector('#setScrim').addEventListener('pointerdown', e => { if (e.target.id === 'setScrim') close(); });
    m.querySelector('#setClose').onclick = close;
    m.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); });
    (tab === 'google' ? bindGoogle : tab === 'map' ? bindMap : tab === 'people' ? bindPeople : bindAccount)(m);
  }
  const card = (title, inner, sub) => `<section style="border:1px solid var(--line);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:12px">
    <div><div style="font-weight:700;font-size:15px">${title}</div>${sub ? `<div class="status">${sub}</div>` : ''}</div>${inner}</section>`;

  /* account */
  function accountHTML() {
    return card('Your details', `<div class="row2"><div class="field"><label for="sName">Name</label><input id="sName" value="${esc(S.user.name)}"></div>
        <div class="field"><label>Username</label><input value="${esc(S.user.username)}" disabled></div></div>
        <div><button class="btn" id="sNameSave">Save name</button></div>`) +
      card('Change password', `<form id="sPw" style="display:flex;flex-direction:column;gap:10px">
        <input type="text" autocomplete="username" value="${esc(S.user.username)}" hidden>
        <div class="field"><label for="sCur">Current password</label><input id="sCur" type="password" autocomplete="current-password" required></div>
        <div class="row2"><div class="field"><label for="sNew">New password</label><input id="sNew" type="password" autocomplete="new-password" minlength="8" required></div>
        <div class="field"><label for="sNew2">Confirm new password</label><input id="sNew2" type="password" autocomplete="new-password" minlength="8" required></div></div>
        <div class="err-msg" id="sPwErr" hidden></div><div><button class="btn primary">Change password</button></div></form>`, 'At least 8 characters. Changing it signs you out on other devices.') +
      `<div class="foot"><a class="btn" href="/logout" style="display:inline-flex;align-items:center;text-decoration:none">Sign out</a><span class="spacer"></span>${S.user.admin ? '<span class="pill confirmed">Admin</span>' : ''}</div>`;
  }
  function bindAccount(m) {
    m.querySelector('#sNameSave').onclick = async () => { try { S = await api('PATCH', '/api/me', { name: m.querySelector('#sName').value }); toast('Name saved'); } catch (e) { toast(errText(e)); } };
    m.querySelector('#sPw').onsubmit = async e => {
      e.preventDefault(); const err = m.querySelector('#sPwErr'); err.hidden = true;
      const cur = m.querySelector('#sCur').value, nw = m.querySelector('#sNew').value;
      if (nw !== m.querySelector('#sNew2').value) { err.textContent = 'The new passwords don\'t match.'; err.hidden = false; return; }
      try { await api('POST', '/api/me/password', { current: cur, next: nw }); m.querySelector('#sPw').reset(); toast('Password changed'); }
      catch (x) { err.textContent = errText(x); err.hidden = false; }
    };
  }

  /* google */
  function googleHTML() {
    const g = S.google, a = S.admin;
    const accounts = g.accounts.length ? g.accounts.map(x => `<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;align-items:center;padding:10px 12px;border-radius:12px;background:var(--hover)">
        <div style="min-width:0"><div style="font-weight:700;overflow:hidden;text-overflow:ellipsis">${esc(x.email || 'Google account')}</div>
        <div class="status">${x.mine ? 'Linked by you' : 'Linked by ' + esc(x.ownerName || 'someone else')}${x.main ? ' · <b>your “My calendar”</b>' : ''}${!x.noscope && !x.broken ? (x.gmail ? ' · email search on' : ' · email search off') : ''}${x.noscope ? ' · <span style="color:var(--danger)">calendar access wasn\'t allowed — link it again and tick the calendar box</span>' : x.broken ? ' · <span style="color:var(--danger)">needs linking again</span>' : ''}</div></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${x.noscope || x.broken ? '<a class="btn primary" href="/auth/google" style="display:inline-flex;align-items:center;text-decoration:none">Link again</a>' : ''}${x.mine && !x.gmail && !x.noscope && !x.broken ? '<a class="btn" href="/auth/google" title="Link again and tick “View your email messages and settings”" style="display:inline-flex;align-items:center;text-decoration:none">Allow email search</a>' : ''}${!x.main && !x.noscope && !x.broken ? `<button class="btn" data-main="${esc(x.id)}" title="Use this account for “My calendar”">Use as mine</button>` : ''}${x.mine || S.user.admin ? `<button class="btn" data-unlink="${esc(x.id)}">Remove</button>` : ''}</div></div>`).join('')
      : '<div class="status">No Google accounts linked yet.</div>';
    let out = card('Linked Google accounts', `<div style="display:flex;flex-direction:column;gap:6px">${accounts}</div>
        <div>${g.configured ? '<a class="btn primary" href="/auth/google" style="display:inline-flex;align-items:center;text-decoration:none">Link a Google account</a>'
          : '<div class="status">Google sign-in isn\'t set up yet.' + (S.user.admin ? ' Fill in the setup below first.' : ' Ask an admin to set it up.') + '</div>'}</div>`,
      'Everyone can link their own Google account. On Google\'s screen, tick the calendar box (required) and the email box (optional). Calendars from every linked account can be added to any trip under Choose calendars. With email allowed, the planner looks for booking confirmations dated on a trip\'s days and suggests them to everyone using the planner. It only reads, never sends or changes email.');
    if (a) {
      out += card('Google sign-in setup', `<ol class="status" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px">
          <li>In <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener" style="color:var(--accent)">Google Cloud Console</a>, create a project and enable the Google Calendar API.</li>
          <li>On the OAuth consent screen choose External, then <b>Publish app</b>. (In Testing mode, add each person as a test user and links expire after 7 days.)</li>
          <li>Under Credentials, create an OAuth client ID of type Web application with this redirect URI:</li></ol>
        <div style="display:flex;gap:8px;align-items:center"><input id="gRedir" readonly value="${esc(g.redirectUri)}" style="flex:1;min-width:0;border:1px solid var(--line);background:var(--hover);border-radius:10px;padding:8px 10px;font-family:var(--mono);font-size:12px"><button class="btn" id="gCopyRedir">Copy</button></div>
        <div class="field"><label for="gBase">Web address of this planner</label><input id="gBase" placeholder="${esc(a.detectedBaseUrl)}" value="${esc(a.baseUrl)}"></div>
        <div class="row2"><div class="field"><label for="gCid">Client ID</label><input id="gCid" value="${esc(a.clientId)}" autocomplete="off"></div>
        <div class="field"><label for="gSec">Client secret</label><input id="gSec" type="password" autocomplete="off" placeholder="${a.hasSecret ? 'Saved — leave blank to keep' : ''}"></div></div>
        <div class="err-msg" id="gErr" hidden></div><div><button class="btn primary" id="gSave">Save setup</button></div>`,
        g.configured ? 'Set up. People can link their Google accounts.' : 'Needed once, before anyone can link a Google account.');
    }
    return out;
  }
  function bindGoogle(m) {
    m.querySelectorAll('[data-unlink]').forEach(b => {
      b.onclick = async () => {
        if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Confirm remove'; b.classList.add('primary'); return; }
        try { S = await api('DELETE', '/api/google/accounts/' + b.dataset.unlink); toast('Google account removed'); mcp.invalidate(); render(); } catch (e) { toast(errText(e)); }
      };
    });
    m.querySelectorAll('[data-main]').forEach(b => b.onclick = async () => {
      try { S = await api('POST', '/api/me/main-account', { id: b.dataset.main }); toast('“My calendar” now uses this account'); mcp.invalidate(); render(); } catch (e) { toast(errText(e)); }
    });
    const copy = m.querySelector('#gCopyRedir');
    if (copy) copy.onclick = () => { const i = m.querySelector('#gRedir'); navigator.clipboard.writeText(i.value).then(() => toast('Redirect URI copied'), () => { i.select(); }); };
    const save = m.querySelector('#gSave');
    if (save) save.onclick = async () => {
      const err = m.querySelector('#gErr'); err.hidden = true;
      try { S = await api('PUT', '/api/config/google', { clientId: m.querySelector('#gCid').value, clientSecret: m.querySelector('#gSec').value, baseUrl: m.querySelector('#gBase').value }); toast('Google setup saved'); render(); mcp.invalidate(); }
      catch (e) { err.textContent = errText(e); err.hidden = false; }
    };
  }

  /* map */
  function mapHTML() {
    const a = S.admin || {};
    return card('Map tiles (CARTO)', `<ol class="status" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px">
        <li>Go to <a href="https://carto.com/basemaps/apikey/" target="_blank" rel="noopener" style="color:var(--accent)">carto.com/basemaps/apikey</a> and click <b>Request a key</b>.</li>
        <li>Enter your email and choose non-commercial use (free up to 5 million tiles a month).</li>
        <li>Paste the key from the email here.</li></ol>
      <div class="field"><label for="mKey">CARTO basemaps key</label><input id="mKey" value="${esc(a.cartoKey || '')}" placeholder="${a.cartoFromEnv ? 'Using the key from the server settings' : 'Paste your key'}" autocomplete="off" spellcheck="false" style="font-family:var(--mono);font-size:12px"></div>
      <div class="err-msg" id="mErr" hidden></div><div><button class="btn primary" id="mSave">Save key</button></div>`,
      S.map && S.map.hasKey ? 'Key set. The map shows the clean Voyager style.' : 'No key yet, so the map can\'t show streets.');
  }
  function bindMap(m) {
    m.querySelector('#mSave').onclick = async () => {
      const err = m.querySelector('#mErr'); err.hidden = true;
      try {
        S = await api('PUT', '/api/config/map', { cartoKey: m.querySelector('#mKey').value }); mapCfg = null; toast('Map key saved'); render();
        if (document.getElementById('tripMap')) setTimeout(() => location.reload(), 700);
      } catch (e) { err.textContent = errText(e); err.hidden = false; }
    };
  }

  /* people */
  function peopleHTML() {
    const rows = (people || []).map(u => `<div data-uid="${esc(u.id)}" style="display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:12px;background:var(--hover)">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div style="flex:1;min-width:140px"><b>${esc(u.name)}</b> <span class="status">@${esc(u.username)}</span>${u.admin ? ' <span class="pill confirmed">Admin</span>' : ''}${u.id === S.user.id ? ' <span class="pill planned">You</span>' : ''}</div>
        <button class="btn" data-act="reset">Set password</button>
        ${u.id !== S.user.id ? `<button class="btn" data-act="admin">${u.admin ? 'Remove admin' : 'Make admin'}</button><button class="btn danger" data-act="remove">Remove</button>` : ''}</div>
        <form data-reset hidden style="display:flex;gap:8px;flex-wrap:wrap"><input type="password" autocomplete="new-password" minlength="8" required placeholder="New password for ${esc(u.name)}" aria-label="New password" style="flex:1;min-width:160px;border:1px solid var(--line);background:var(--solid);border-radius:10px;padding:8px 10px"><button class="btn primary">Save</button></form></div>`).join('');
    return card('People', `<div style="display:flex;flex-direction:column;gap:6px">${rows}</div>`, 'Everyone here can see and edit all trips. Admins can also add people and set up Google.') +
      card('Add a person', `<form id="pAdd" style="display:flex;flex-direction:column;gap:10px">
        <div class="row2"><div class="field"><label for="pName">Name</label><input id="pName" required placeholder="Alex"></div>
        <div class="field"><label for="pUser">Username</label><input id="pUser" required pattern="[a-z0-9._\-]{2,32}" title="2–32 lowercase letters, numbers, dots or dashes" placeholder="sara" autocomplete="off"></div></div>
        <div class="field"><label for="pPw">Password</label><input id="pPw" type="password" autocomplete="new-password" minlength="8" required></div>
        <label class="check"><input type="checkbox" id="pAdmin"> Admin</label>
        <div class="err-msg" id="pErr" hidden></div><div><button class="btn primary">Add person</button></div></form>`, 'They can change their password themselves after signing in.');
  }
  function bindPeople(m) {
    m.querySelectorAll('[data-uid]').forEach(row => {
      const id = row.dataset.uid, u = people.find(x => x.id === id), form = row.querySelector('[data-reset]');
      row.querySelector('[data-act="reset"]').onclick = () => { form.hidden = !form.hidden; if (!form.hidden) form.querySelector('input').focus(); };
      form.onsubmit = async e => { e.preventDefault(); try { people = (await api('PATCH', '/api/users/' + id, { password: form.querySelector('input').value })).users; toast('Password set for ' + u.name); render(); } catch (x) { toast(errText(x)); } };
      const adm = row.querySelector('[data-act="admin"]');
      if (adm) adm.onclick = async () => { try { people = (await api('PATCH', '/api/users/' + id, { admin: !u.admin })).users; render(); } catch (x) { toast(errText(x)); } };
      const rm = row.querySelector('[data-act="remove"]');
      if (rm) rm.onclick = async () => {
        if (!rm.dataset.armed) { rm.dataset.armed = '1'; rm.textContent = 'Confirm remove'; rm.classList.add('primary'); return; }
        try { people = (await api('DELETE', '/api/users/' + id)).users; toast(u.name + ' removed'); render(); } catch (x) { toast(errText(x)); }
      };
    });
    m.querySelector('#pAdd').onsubmit = async e => {
      e.preventDefault(); const err = m.querySelector('#pErr'); err.hidden = true;
      try { people = (await api('POST', '/api/users', { name: m.querySelector('#pName').value, username: m.querySelector('#pUser').value, password: m.querySelector('#pPw').value, admin: m.querySelector('#pAdmin').checked })).users; toast('Person added'); render(); }
      catch (x) { err.textContent = errText(x); err.hidden = false; }
    };
  }

  /* gear button in the top bar, and returning from Google */
  document.addEventListener('DOMContentLoaded', () => {
    const top = document.querySelector('.top');
    if (top) {
      const b = document.createElement('button'); b.className = 'icon-btn'; b.id = 'settingsBtn'; b.setAttribute('aria-label', 'Settings'); b.title = 'Settings';
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.1 7.1 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2.5h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.67 8.98a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.04.24.25.42.49.42h3.84c.24 0 .45-.18.49-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/></svg>';
      b.onclick = () => openSettings();
      top.appendChild(b);
    }
    const q = new URLSearchParams(location.search);
    if (q.has('settings') || q.has('google')) {
      const msg = { linked: 'Google account linked', denied: 'Google linking was cancelled', failed: 'Google didn\'t finish linking. Check the setup and try again.', expired: 'That link expired. Try linking again.', noscope: 'Google didn\'t give calendar access. Link again and tick “See, edit, share and delete all your calendars”.', not_configured: 'Google sign-in needs setting up first.' }[q.get('google')];
      history.replaceState(null, '', location.pathname);
      setTimeout(() => { openSettings(q.get('settings') || 'google'); if (msg) toast(msg); }, 300);
    }
  });

  window.ITIN_HOST = {
    use: n => n === 'mcp' ? mcp : null,
    store,
    openSettings,
    mailScan: (days, refresh) => api('POST', '/api/mail/scan', { days, refresh }),
    geo: {
      search: (q, limit) => api('GET', '/api/geo/search?q=' + encodeURIComponent(q) + '&limit=' + (limit || 5)).then(r => r.results || []),
      reverse: (lat, lng) => api('GET', `/api/geo/reverse?lat=${lat}&lng=${lng}`),
      route: (mode, points) => api('POST', '/api/route', { mode, points }),
      transit: (from, to, time, arriveBy) => api('POST', '/api/transit', { from, to, time, arriveBy }),
      config: () => (mapCfg = mapCfg || api('GET', '/api/map-config'))
    },
    msgs: {
      needs_reauth: 'A Google account needs linking again. Open Settings → Google Calendar.',
      server_not_connected: 'No Google account is linked yet. Open Settings → Google Calendar.',
      not_configured: 'Google sign-in isn\'t set up yet. An admin can add it in Settings → Google Calendar.',
      unauthenticated: 'Signed out. Reload to sign in.'
    },
    gpanelExtra(cals) {
      const need = cals.some(d => d.state === 'error' && ['server_not_connected', 'needs_reauth', 'not_configured'].includes(d.code));
      return `<button class="btn ${need ? 'primary' : 'ghost'}" type="button" onclick="ITIN_HOST.openSettings('google')">${need ? 'Set up Google Calendar' : 'Google accounts'}</button>`;
    }
  };
})();
