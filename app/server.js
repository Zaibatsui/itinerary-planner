// Itinerary Planner — self-hosted server. Node 20+, no dependencies.
// Users sign in with their own password; each user can link one or more Google accounts.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mail = require('./mail');
const geo = require('./geo');

const PORT = Number(process.env.PORT || 8080);
const DATA = process.env.DATA_DIR || '/data';
const TZ = process.env.TZ || 'Europe/London';
const PUBLIC = path.join(__dirname, 'public');

fs.mkdirSync(DATA, { recursive: true });
const F = n => path.join(DATA, n);
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 1), { mode: 0o600 }); fs.renameSync(t, f); };

let state = readJSON(F('state.json'), { trips: {}, items: {}, places: {} });
state.places = state.places || {};
geo.init(F('geocache.json'));
let users = readJSON(F('users.json'), []);
let config = readJSON(F('config.json'), {});
let google = readJSON(F('google.json'), { accounts: {} });
let secret; try { secret = fs.readFileSync(F('secret'), 'utf8'); } catch { secret = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(F('secret'), secret, { mode: 0o600 }); }
// state is saved in the background so a slow disk (e.g. a Docker Desktop bind mount) never holds up requests
let saving = false, dirty = false;
async function flushState() {
  saving = true;
  while (dirty) {
    dirty = false;
    const f = F('state.json'), data = JSON.stringify(state, null, 1);
    try { await fs.promises.writeFile(f + '.tmp', data, { mode: 0o600 }); await fs.promises.rename(f + '.tmp', f); }
    catch (e) { try { await fs.promises.writeFile(f, data, { mode: 0o600 }); } catch (e2) { console.error('Saving state failed:', e2.message); } }
  }
  saving = false;
}
const saveState = () => { dirty = true; if (!saving) flushState(); };
const flushNow = () => { if (dirty || saving) try { fs.writeFileSync(F('state.json'), JSON.stringify(state, null, 1), { mode: 0o600 }); } catch {} };
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { flushNow(); process.exit(0); });
const saveUsers = () => writeJSON(F('users.json'), users);
const saveConfig = () => writeJSON(F('config.json'), config);
const saveGoogle = () => writeJSON(F('google.json'), google);

/* ---------- passwords & users ---------- */
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') });
const checkPw = (u, pw) => { if (!u || !u.hash) { crypto.scryptSync('x', 'y', 64); return false; } const h = crypto.scryptSync(String(pw), u.salt, 64); return crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex')); };
const newId = () => crypto.randomBytes(9).toString('base64url');
const pubUser = u => ({ id: u.id, name: u.name, username: u.username, admin: !!u.admin });
const pwProblem = pw => (typeof pw !== 'string' || pw.length < 8) ? 'Use at least 8 characters.' : null;
const nameOk = s => typeof s === 'string' && /^[a-z0-9._-]{2,32}$/.test(s);

// one-time migrations from the first version (single shared password, single Google token)
if (!users.length && process.env.APP_PASSWORD) {
  users.push({ id: newId(), name: 'Admin', username: 'admin', admin: true, ...hashPw(process.env.APP_PASSWORD), createdAt: new Date().toISOString() });
  saveUsers();
}
if (google && google.refresh_token) {
  const id = newId();
  google = { accounts: { [id]: { email: google.email || '', refresh_token: google.refresh_token, ownerId: (users[0] || {}).id || '', addedAt: new Date().toISOString() } } };
  saveGoogle();
}
google.accounts = google.accounts || {};
const gcfg = () => ({ clientId: config.googleClientId || process.env.GOOGLE_CLIENT_ID || '', clientSecret: config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || '' });

/* ---------- http helpers ---------- */
const send = (res, code, body, headers = {}) => {
  const obj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'content-type': obj ? 'application/json' : 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', ...headers });
  res.end(obj ? JSON.stringify(body) : body);
};
const fail = (res, code, c, message) => send(res, code, { error: { code: c, message } });
const readBody = req => new Promise((ok, bad) => {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > 2e6) { bad(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
  req.on('error', bad);
});
const jsonBody = async req => { try { const v = JSON.parse((await readBody(req)) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const sign = v => crypto.createHmac('sha256', secret).update(v).digest('base64url');
const isHttps = req => String(req.headers['x-forwarded-proto'] || '').startsWith('https');
const cookieOpts = (req, maxAge) => `HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
const makeSession = u => { const v = `${u.id}.${Date.now() + 1000 * 60 * 60 * 24 * 60}.${u.sv || 0}`; return v + '.' + sign(v); };
function sessionUser(req) {
  const s = cookies(req).itin_sid; if (!s) return null;
  const parts = s.split('.'); if (parts.length !== 4) return null;
  const v = parts.slice(0, 3).join('.'), mac = parts[3], good = sign(v);
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  if (Number(parts[1]) < Date.now()) return null;
  const u = users.find(x => x.id === parts[0]);
  return u && String(u.sv || 0) === parts[2] ? u : null;   // changing a password signs out other sessions
}
const baseUrl = req => (config.baseUrl || process.env.BASE_URL || `${isHttps(req) ? 'https' : 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/$/, '');
const okId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s);

/* ---------- sign-in pages ---------- */
const page = (title, inner) => `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Itinerary Planner · ${title}</title><link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=Figtree:wght@400;600;700&display=swap">
<style>:root{--bg:#f5f6fb;--fg:#141629;--muted:#646a85;--card:#fff;--line:#e3e6f0}
@media (prefers-color-scheme:dark){:root{--bg:#0c0e19;--fg:#eef0fa;--muted:#9ba1bf;--card:#171a2b;--line:#262a40}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Figtree,system-ui,sans-serif;background:var(--bg);color:var(--fg);padding:16px;
background-image:radial-gradient(60vw 50vh at 0% 0%,#ffd8c844,transparent 70%),radial-gradient(50vw 45vh at 100% 0%,#c6f1ea55,transparent 70%)}
form{background:var(--card);border:1px solid var(--line);border-radius:24px;padding:28px;width:min(380px,100%);display:flex;flex-direction:column;gap:12px;box-shadow:0 24px 60px -12px rgba(20,22,41,.25)}
h1{font-family:'Bricolage Grotesque',Figtree,sans-serif;font-weight:800;margin:0 0 4px;font-size:26px;letter-spacing:-.02em}
p{margin:0;color:var(--muted);line-height:1.5}label{font-size:12px;font-weight:700;color:var(--muted);display:flex;flex-direction:column;gap:5px}
input{font:inherit;font-size:15px;padding:11px 12px;border-radius:12px;border:1px solid var(--line);background:transparent;color:inherit}
button{font:inherit;font-weight:700;height:46px;border:0;border-radius:12px;color:#fff;background:linear-gradient(135deg,#ff5a36,#ff9a3d);cursor:pointer;margin-top:4px}.e{color:#e5383b;font-size:14px}</style></head>
<body>${inner}</body></html>`;
const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const loginPage = (err = '', uname = '') => page('Sign in', `<form method="post" action="/login"><h1>Itinerary</h1><p>Sign in to your trips.</p>
<label>Username<input name="username" autocomplete="username" value="${esc(uname)}" required ${uname ? '' : 'autofocus'}></label>
<label>Password<input type="password" name="password" autocomplete="current-password" required ${uname ? 'autofocus' : ''}></label>
${err ? `<div class="e">${esc(err)}</div>` : ''}<button>Sign in</button></form>`);
const setupPage = (err = '') => page('Set up', `<form method="post" action="/setup"><h1>Welcome</h1><p>Create the first account. It can add other people and set up Google Calendar in Settings.</p>
<label>Your name<input name="name" required autofocus></label>
<label>Username<input name="username" autocomplete="username" pattern="[a-z0-9._\-]{2,32}" title="2–32 lowercase letters, numbers, dots, dashes" required></label>
<label>Password<input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
<label>Confirm password<input type="password" name="confirm" autocomplete="new-password" minlength="8" required></label>
${err ? `<div class="e">${esc(err)}</div>` : ''}<button>Create account</button></form>`);

/* ---------- Google ---------- */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const gErr = (code, message, extra = {}) => Object.assign(new Error(message), { gcode: code, ...extra });
const usable = a => !a.broken && !a.noscope;
const accountsFor = u => {
  const all = Object.entries(google.accounts).map(([id, a]) => ({ id, ...a }));
  const rank = a => (u && a.id === u.mainAccount ? 0 : u && a.ownerId === u.id ? 1 : 2) + (usable(a) ? 0 : 3);
  return all.sort((x, y) => rank(x) - rank(y));
};
const hasCalScope = scope => String(scope || '').split(/\s+/).includes('https://www.googleapis.com/auth/calendar');
const hasMailScope = scope => String(scope || '').split(/\s+/).includes('https://www.googleapis.com/auth/gmail.readonly');
const calMap = new Map();   // calendarId -> account id that can read it (best access first)

async function accessToken(accId) {
  const { clientId, clientSecret } = gcfg();
  if (!clientId || !clientSecret) throw gErr('not_configured', 'Google sign-in isn\'t set up yet. An admin can add it in Settings → Google Calendar.');
  const a = google.accounts[accId]; if (!a) throw gErr('server_not_connected', 'No Google account is linked yet. Link one in Settings → Google Calendar.');
  if (a.access_token && a.expiry > Date.now() + 60000) return a.access_token;
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: a.refresh_token, grant_type: 'refresh_token' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { if (j.error === 'invalid_grant') { a.broken = true; saveGoogle(); } throw gErr('needs_reauth', `Google sign-in for ${a.email || 'an account'} has expired. Link it again in Settings.`); }
  if (j.scope && !hasCalScope(j.scope)) { a.noscope = true; saveGoogle(); throw gErr('needs_reauth', `${a.email || 'A linked Google account'} didn't allow calendar access. Link it again in Settings and tick the calendar box.`); }
  if (j.scope) a.gmail = hasMailScope(j.scope);
  a.access_token = j.access_token; a.expiry = Date.now() + (j.expires_in || 3600) * 1000; a.broken = false; a.noscope = false; saveGoogle();
  return a.access_token;
}
async function gfetch(accId, method, url, body) {
  const t = await accessToken(accId);
  const r = await fetch(API + url, { method, headers: { authorization: 'Bearer ' + t, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (r.ok) return j;
  const msg = (j.error && j.error.message) || ('Google returned ' + r.status);
  if (r.status === 401) throw gErr('needs_reauth', 'Google sign-in has expired. Link the account again in Settings.');
  if (r.status >= 500 || r.status === 429) throw gErr('server_unavailable', msg, { retryable: true });
  throw gErr('tool_error', msg, { status: r.status });
}
// pick which linked account to use for a calendar; "primary" means the signed-in user's own first account
async function withCalendar(u, calId, fn) {
  const accs = accountsFor(u).filter(usable);
  if (!accs.length) throw gErr(Object.keys(google.accounts).length ? 'needs_reauth' : 'server_not_connected',
    Object.keys(google.accounts).length ? 'The linked Google account needs linking again in Settings.' : 'No Google account is linked yet. Link one in Settings → Google Calendar.');
  if (calId === 'primary') { const a = accs[0]; return fn(a.id, a.email || 'primary'); }
  // a person's own account sees everything on their calendar, including private events Gmail adds from bookings
  const own = accs.find(a => a.email && a.email.toLowerCase() === String(calId).toLowerCase());
  const known = own ? own.id : calMap.get(calId);
  const order = known ? [accs.find(a => a.id === known), ...accs.filter(a => a.id !== known)].filter(Boolean) : accs;
  let last;
  for (const a of order) {
    try { const out = await fn(a.id, calId); calMap.set(calId, a.id); return out; }
    catch (e) { last = e; if (e.gcode !== 'tool_error' || ![403, 404].includes(e.status)) throw e; }
  }
  throw last;
}
function tzOffsetMin(utcMs) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs) / 60000;
}
function localToRFC(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || ''));
  if (!m) return s;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let off = tzOffsetMin(guess); off = tzOffsetMin(guess - off * 60000);
  return new Date(guess - off * 60000).toISOString();
}
const enumType = t => String(t || 'default').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
const timeBody = inp => {
  const b = {};
  if (inp.allDay === true) { b.start = { date: String(inp.startTime).slice(0, 10), dateTime: null }; b.end = { date: String(inp.endTime).slice(0, 10), dateTime: null }; }
  else if (inp.startTime) { b.start = { dateTime: String(inp.startTime).slice(0, 19), timeZone: TZ, date: null }; b.end = { dateTime: String(inp.endTime).slice(0, 19), timeZone: TZ, date: null }; }
  return b;
};
const enc = encodeURIComponent;
const RANK = { owner: 4, writer: 3, reader: 2, freeBusyReader: 1 };
const TOOLS = {
  async list_calendars(u) {
    const accs = accountsFor(u).filter(usable);
    if (!accs.length) throw gErr(Object.keys(google.accounts).length ? 'needs_reauth' : 'server_not_connected', Object.keys(google.accounts).length ? 'Your linked Google accounts need linking again in Settings.' : 'No Google account is linked yet. Link one in Settings → Google Calendar.');
    const best = new Map(); let firstErr = null, okCount = 0;
    for (const a of accs) {
      let j; try { j = await gfetch(a.id, 'GET', '/users/me/calendarList?maxResults=250'); okCount++; } catch (e) { firstErr = firstErr || e; continue; }
      for (const c of j.items || []) {
        const prev = best.get(c.id);
        if (!prev || (RANK[c.accessRole] || 0) > (RANK[prev.accessRole] || 0)) best.set(c.id, { id: c.id, summary: c.summaryOverride || c.summary, accessRole: c.accessRole, primary: !!c.primary, account: a.email, accId: a.id });
      }
    }
    if (!okCount && firstErr) throw firstErr;
    for (const c of best.values()) calMap.set(c.id, c.accId);
    return { calendars: [...best.values()].map(({ accId, ...c }) => c) };
  },
  list_events(u, inp) {
    return withCalendar(u, inp.calendarId || 'primary', async (acc, cal) => {
      const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.min(250, inp.pageSize || 250)), timeMin: localToRFC(inp.startTime), timeMax: localToRFC(inp.endTime) });
      for (const t of ['default', 'outOfOffice', 'focusTime', 'fromGmail']) q.append('eventTypes', t);
      const j = await gfetch(acc, 'GET', `/calendars/${enc(cal)}/events?` + q);
      return { accessRole: j.accessRole, summary: j.summary, timeZone: j.timeZone, nextPageToken: j.nextPageToken, events: (j.items || []).map(e => ({ ...e, eventType: enumType(e.eventType) })) };
    });
  },
  update_event(u, inp) {
    const b = { ...timeBody(inp) };
    for (const k of ['summary', 'location', 'description']) if (inp[k] !== undefined) b[k] = inp[k];
    const su = inp.notificationLevel === 'ALL' ? 'all' : 'none';
    return withCalendar(u, inp.calendarId || 'primary', (acc, cal) => gfetch(acc, 'PATCH', `/calendars/${enc(cal)}/events/${enc(inp.eventId)}?sendUpdates=${su}`, b));
  },
  delete_event(u, inp) {
    const su = inp.notificationLevel === 'ALL' ? 'all' : 'none';
    return withCalendar(u, inp.calendarId || 'primary', async (acc, cal) => { await gfetch(acc, 'DELETE', `/calendars/${enc(cal)}/events/${enc(inp.eventId)}?sendUpdates=${su}`); return { deleted: true }; });
  },
  create_event(u, inp) {
    const b = { summary: inp.summary, location: inp.location, description: inp.description, ...timeBody(inp) };
    for (const k of ['start', 'end']) if (b[k]) { if (b[k].date === null) delete b[k].date; if (b[k].dateTime === null) delete b[k].dateTime; }
    return withCalendar(u, inp.calendarId || 'primary', (acc, cal) => gfetch(acc, 'POST', `/calendars/${enc(cal)}/events`, b));
  }
};

/* ---------- settings payload ---------- */
function settingsFor(u, req) {
  const { clientId, clientSecret } = gcfg();
  return {
    user: pubUser(u),
    google: {
      configured: !!(clientId && clientSecret),
      redirectUri: baseUrl(req) + '/auth/google/callback',
      accounts: accountsFor(u).map(a => ({ id: a.id, email: a.email, mine: a.ownerId === u.id, main: a.id === u.mainAccount, ownerName: (users.find(x => x.id === a.ownerId) || {}).name || '', broken: !!a.broken, noscope: !!a.noscope, gmail: !!a.gmail, addedAt: a.addedAt }))
    },
    admin: u.admin ? { clientId, hasSecret: !!clientSecret, fromEnv: !config.googleClientId && !!process.env.GOOGLE_CLIENT_ID, baseUrl: config.baseUrl || process.env.BASE_URL || '', detectedBaseUrl: baseUrl({ headers: req.headers }), cartoKey: config.cartoKey || '', cartoFromEnv: !config.cartoKey && !!process.env.CARTO_KEY } : null,
    map: { hasKey: !!(config.cartoKey || process.env.CARTO_KEY) }
  };
}

/* ---------- static ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serveStatic(res, rel) {
  const f = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(PUBLIC)) return send(res, 404, 'Not found');
  fs.readFile(f, (e, buf) => {
    if (e) return send(res, 404, 'Not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(buf);
  });
}

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname; const M = req.method;
  try {
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (p === '/icon.svg' || p === '/manifest.webmanifest') return serveStatic(res, p);

    // first run: create the first (admin) account
    if (!users.length) {
      if (p === '/setup' && M === 'POST') {
        const f = new URLSearchParams(await readBody(req));
        const name = (f.get('name') || '').trim(), username = (f.get('username') || '').trim().toLowerCase(), pw = f.get('password') || '';
        if (!name || !nameOk(username)) return send(res, 400, setupPage('Use 2–32 lowercase letters, numbers, dots or dashes for the username.'));
        if (pwProblem(pw)) return send(res, 400, setupPage(pwProblem(pw)));
        if (pw !== f.get('confirm')) return send(res, 400, setupPage('The two passwords don\'t match.'));
        const u = { id: newId(), name, username, admin: true, ...hashPw(pw), createdAt: new Date().toISOString() };
        users.push(u); saveUsers();
        return send(res, 302, '', { location: '/', 'set-cookie': `itin_sid=${makeSession(u)}; ${cookieOpts(req, 5184000)}` });
      }
      if (p.startsWith('/api/')) return fail(res, 401, 'unauthenticated', 'Set up the first account first.');
      return p === '/setup' ? send(res, 200, setupPage()) : send(res, 302, '', { location: '/setup' });
    }

    if (p === '/login' && M === 'GET') return send(res, 200, loginPage());
    if (p === '/login' && M === 'POST') {
      const f = new URLSearchParams(await readBody(req));
      const username = (f.get('username') || '').trim().toLowerCase();
      const u = users.find(x => x.username === username);
      if (checkPw(u, f.get('password') || '')) return send(res, 302, '', { location: '/', 'set-cookie': `itin_sid=${makeSession(u)}; ${cookieOpts(req, 5184000)}` });
      await new Promise(r => setTimeout(r, 900));
      return send(res, 401, loginPage('That username or password isn\'t right.', username));
    }
    if (p === '/logout') return send(res, 302, '', { location: '/login', 'set-cookie': `itin_sid=; ${cookieOpts(req, 0)}` });

    const me = sessionUser(req);
    if (!me) return p.startsWith('/api/') ? fail(res, 401, 'unauthenticated', 'Sign in again.') : send(res, 302, '', { location: '/login' });

    /* Google account linking — any signed-in user can link their own Google account */
    if (p === '/auth/google') {
      const { clientId, clientSecret } = gcfg();
      if (!clientId || !clientSecret) return send(res, 302, '', { location: '/?settings=google&google=not_configured' });
      const st = crypto.randomBytes(16).toString('hex');
      const q = new URLSearchParams({ client_id: clientId, redirect_uri: baseUrl(req) + '/auth/google/callback', response_type: 'code', access_type: 'offline', prompt: 'consent select_account',
        scope: 'openid email https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.readonly', include_granted_scopes: 'true', state: st });
      return send(res, 302, '', { location: 'https://accounts.google.com/o/oauth2/v2/auth?' + q, 'set-cookie': `itin_oauth=${st}; ${cookieOpts(req, 600)}` });
    }
    if (p === '/auth/google/callback') {
      if (!url.searchParams.get('state') || url.searchParams.get('state') !== cookies(req).itin_oauth) return send(res, 302, '', { location: '/?settings=google&google=expired' });
      if (url.searchParams.get('error')) return send(res, 302, '', { location: '/?settings=google&google=denied' });
      const { clientId, clientSecret } = gcfg();
      const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: clientId, client_secret: clientSecret, redirect_uri: baseUrl(req) + '/auth/google/callback', grant_type: 'authorization_code' }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.refresh_token) return send(res, 302, '', { location: '/?settings=google&google=failed' });
      if (!hasCalScope(j.scope)) return send(res, 302, '', { location: '/?settings=google&google=noscope' });
      let email = '';
      try { email = JSON.parse(Buffer.from(String(j.id_token).split('.')[1], 'base64url').toString()).email || ''; } catch {}
      const existing = Object.entries(google.accounts).find(([, a]) => a.email && a.email === email);
      const id = existing ? existing[0] : newId();
      google.accounts[id] = { email, refresh_token: j.refresh_token, access_token: j.access_token, expiry: Date.now() + (j.expires_in || 3600) * 1000, ownerId: me.id, addedAt: new Date().toISOString(), gmail: hasMailScope(j.scope) };
      mail.clearCache();
      if (!me.mainAccount || !google.accounts[me.mainAccount]) { me.mainAccount = id; saveUsers(); }
      saveGoogle(); calMap.clear();
      return send(res, 302, '', { location: '/?settings=google&google=linked', 'set-cookie': `itin_oauth=; ${cookieOpts(req, 0)}` });
    }

    /* settings API */
    if (p === '/api/settings' && M === 'GET') return send(res, 200, settingsFor(me, req));
    if (p === '/api/me' && M === 'PATCH') {
      const b = await jsonBody(req); if (!b) return fail(res, 400, 'invalid_argument', 'Bad request');
      if (typeof b.name === 'string' && b.name.trim()) me.name = b.name.trim().slice(0, 60);
      saveUsers(); return send(res, 200, settingsFor(me, req));
    }
    if (p === '/api/me/password' && M === 'POST') {
      const b = await jsonBody(req); if (!b) return fail(res, 400, 'invalid_argument', 'Bad request');
      if (!checkPw(me, b.current || '')) { await new Promise(r => setTimeout(r, 700)); return fail(res, 400, 'wrong_password', 'Your current password isn\'t right.'); }
      if (pwProblem(b.next)) return fail(res, 400, 'weak_password', pwProblem(b.next));
      Object.assign(me, hashPw(b.next)); me.sv = (me.sv || 0) + 1; saveUsers();
      return send(res, 200, { ok: true }, { 'set-cookie': `itin_sid=${makeSession(me)}; ${cookieOpts(req, 5184000)}` });
    }
    let m = /^\/api\/google\/accounts\/([^/]+)$/.exec(p);
    if (m && M === 'DELETE') {
      const a = google.accounts[m[1]]; if (!a) return fail(res, 404, 'invalid_argument', 'Not found');
      if (a.ownerId !== me.id && !me.admin) return fail(res, 403, 'forbidden', 'Only the person who linked this account, or an admin, can remove it.');
      delete google.accounts[m[1]]; saveGoogle(); calMap.clear(); return send(res, 200, settingsFor(me, req));
    }
    if (p === '/api/me/main-account' && M === 'POST') {
      const b = await jsonBody(req); if (!b || !google.accounts[b.id]) return fail(res, 400, 'invalid_argument', 'Pick a linked account.');
      me.mainAccount = b.id; saveUsers(); calMap.clear(); return send(res, 200, settingsFor(me, req));
    }
    if (p === '/api/config/google' && M === 'PUT') {
      if (!me.admin) return fail(res, 403, 'forbidden', 'Only an admin can change this.');
      const b = await jsonBody(req); if (!b) return fail(res, 400, 'invalid_argument', 'Bad request');
      if (typeof b.clientId === 'string') config.googleClientId = b.clientId.trim();
      if (typeof b.clientSecret === 'string' && b.clientSecret.trim()) config.googleClientSecret = b.clientSecret.trim();
      if (typeof b.baseUrl === 'string') config.baseUrl = b.baseUrl.trim().replace(/\/$/, '');
      if (config.baseUrl && !/^https?:\/\/[^\s/]+$/.test(config.baseUrl)) return fail(res, 400, 'invalid_argument', 'The web address should look like https://trips.example.com');
      saveConfig(); return send(res, 200, settingsFor(me, req));
    }
    if (p === '/api/users' && M === 'GET') {
      if (!me.admin) return fail(res, 403, 'forbidden', 'Only an admin can see users.');
      return send(res, 200, { users: users.map(pubUser) });
    }
    if (p === '/api/users' && M === 'POST') {
      if (!me.admin) return fail(res, 403, 'forbidden', 'Only an admin can add people.');
      const b = await jsonBody(req); if (!b) return fail(res, 400, 'invalid_argument', 'Bad request');
      const username = String(b.username || '').trim().toLowerCase(), name = String(b.name || '').trim();
      if (!name) return fail(res, 400, 'invalid_argument', 'Add a name.');
      if (!nameOk(username)) return fail(res, 400, 'invalid_argument', 'Use 2–32 lowercase letters, numbers, dots or dashes for the username.');
      if (users.some(x => x.username === username)) return fail(res, 400, 'invalid_argument', 'That username is taken.');
      if (pwProblem(b.password)) return fail(res, 400, 'weak_password', pwProblem(b.password));
      users.push({ id: newId(), name: name.slice(0, 60), username, admin: !!b.admin, ...hashPw(b.password), createdAt: new Date().toISOString() }); saveUsers();
      return send(res, 200, { users: users.map(pubUser) });
    }
    m = /^\/api\/users\/([^/]+)$/.exec(p);
    if (m) {
      if (!me.admin) return fail(res, 403, 'forbidden', 'Only an admin can change people.');
      const u = users.find(x => x.id === m[1]); if (!u) return fail(res, 404, 'invalid_argument', 'Not found');
      if (M === 'DELETE') {
        if (u.id === me.id) return fail(res, 400, 'invalid_argument', 'You can\'t remove yourself.');
        users = users.filter(x => x.id !== u.id); saveUsers(); return send(res, 200, { users: users.map(pubUser) });
      }
      if (M === 'PATCH') {
        const b = await jsonBody(req); if (!b) return fail(res, 400, 'invalid_argument', 'Bad request');
        if (typeof b.name === 'string' && b.name.trim()) u.name = b.name.trim().slice(0, 60);
        if (typeof b.admin === 'boolean') {
          if (u.id === me.id && !b.admin) return fail(res, 400, 'invalid_argument', 'You can\'t remove your own admin rights.');
          u.admin = b.admin;
        }
        if (b.password !== undefined) { if (pwProblem(b.password)) return fail(res, 400, 'weak_password', pwProblem(b.password)); Object.assign(u, hashPw(b.password)); u.sv = (u.sv || 0) + 1; }
        saveUsers(); return send(res, 200, { users: users.map(pubUser) });
      }
    }

    /* booking confirmations found in linked Gmail inboxes */
    if (p === '/api/mail/scan' && M === 'POST') {
      const b = await jsonBody(req);
      const days = (b && Array.isArray(b.days) ? b.days : []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(0, 120);
      if (!days.length) return send(res, 200, { bookings: [], accounts: [] });
      if (b.refresh) mail.clearCache();
      const accounts = [], all = [];
      for (const a of accountsFor(me).filter(usable)) {
        if (!a.gmail) { accounts.push({ email: a.email, gmail: false }); continue; }
        try { const t = await accessToken(a.id); all.push(...await mail.scanAccount(a, t, days)); accounts.push({ email: a.email, gmail: true }); }
        catch (e) {
          const apiOff = /has not been used|is disabled|accessNotConfigured/i.test(e.message || '');
          if (e.status === 403 && !apiOff) { google.accounts[a.id].gmail = false; saveGoogle(); }
          accounts.push({ email: a.email, gmail: apiOff || e.status !== 403,
            error: apiOff ? 'The Gmail API is switched off in the Google Cloud project. Enable it in Google Cloud Console → APIs & Services → Library → Gmail API.'
              : e.status === 403 ? 'Email access wasn\'t allowed for this account.' : (e.message || 'Couldn\'t search this inbox.') });
        }
      }
      return send(res, 200, { bookings: mail.merge(all), accounts });
    }

    /* Google Calendar bridge */
    const tool = /^\/api\/gcal\/([a-z_]+)$/.exec(p);
    if (tool && M === 'POST') {
      const fn = TOOLS[tool[1]]; if (!fn) return fail(res, 404, 'bad_request', 'Unknown tool');
      const inp = (await jsonBody(req)) || {};
      try { return send(res, 200, { payload: await fn(me, inp) }); }
      catch (e) { return send(res, e.gcode === 'tool_error' ? 400 : 502, { error: { code: e.gcode || 'upstream_error', message: e.message, retryable: !!e.retryable } }); }
    }

    /* map: tiles key, place search and routing */
    if (p === '/api/map-config' && M === 'GET') return send(res, 200, { cartoKey: config.cartoKey || process.env.CARTO_KEY || '' });
    if (p === '/api/config/map' && M === 'PUT') {
      if (!me.admin) return fail(res, 403, 'forbidden', 'Only an admin can change this.');
      const b = await jsonBody(req); if (!b) return fail(res, 400, 'invalid_argument', 'Bad request');
      const k = String(b.cartoKey || '').trim();
      if (k && !/^[A-Za-z0-9._-]{8,200}$/.test(k)) return fail(res, 400, 'invalid_argument', 'That doesn\'t look like a CARTO key. Paste it exactly as it arrived in the email.');
      config.cartoKey = k; saveConfig();
      return send(res, 200, settingsFor(me, req));
    }
    if (p === '/api/geo/search' && M === 'GET') {
      try { return send(res, 200, { results: await geo.search(url.searchParams.get('q'), Math.min(8, +url.searchParams.get('limit') || 5)) }); }
      catch (e) { return fail(res, 502, 'upstream_error', e.message); }
    }
    if (p === '/api/geo/reverse' && M === 'GET') {
      const la = +url.searchParams.get('lat'), ln = +url.searchParams.get('lng');
      if (!isFinite(la) || !isFinite(ln)) return fail(res, 400, 'invalid_argument', 'lat and lng are needed');
      try { return send(res, 200, await geo.reverse(la, ln)); } catch (e) { return fail(res, 502, 'upstream_error', e.message); }
    }
    if (p === '/api/transit' && M === 'POST') {
      const b = await jsonBody(req);
      const ok = x => Array.isArray(x) && x.length === 2 && x.every(v => isFinite(v));
      if (!b || !ok(b.from) || !ok(b.to) || !b.time) return fail(res, 400, 'invalid_argument', 'from, to and time are needed');
      try { return send(res, 200, await geo.transit(b.from, b.to, b.time, !!b.arriveBy)); }
      catch (e) { return fail(res, 502, 'upstream_error', e.message); }
    }
    if (p === '/api/route' && M === 'POST') {
      const b = await jsonBody(req);
      const pts = (b && Array.isArray(b.points) ? b.points : []).filter(x => Array.isArray(x) && isFinite(x[0]) && isFinite(x[1])).slice(0, 25);
      if (pts.length < 2) return fail(res, 400, 'invalid_argument', 'Two or more points are needed.');
      try { return send(res, 200, await geo.route(['foot', 'car', 'bike'].includes(b.mode) ? b.mode : 'foot', pts)); }
      catch (e) { return fail(res, 502, 'upstream_error', 'Routing failed: ' + e.message); }
    }

    /* your places (shared list of saved spots) */
    m = /^\/api\/places\/([^/]+)$/.exec(p);
    if (m && okId(m[1]) && m[1] !== 'import') {
      const id = m[1];
      if (M === 'DELETE') { delete state.places[id]; saveState(); return send(res, 200, { ok: true }); }
      const body = await jsonBody(req); if (!body) return fail(res, 400, 'invalid_argument', 'Body must be an object');
      if (!isFinite(body.lat ?? (state.places[id] || {}).lat)) return fail(res, 400, 'invalid_argument', 'A place needs a location.');
      if (M === 'PUT') state.places[id] = body;
      else if (M === 'PATCH') { if (!state.places[id]) return fail(res, 404, 'invalid_argument', 'No such place'); state.places[id] = { ...state.places[id], ...body }; }
      else return fail(res, 405, 'bad_request', 'Method not allowed');
      saveState(); return send(res, 200, { ok: true });
    }
    if (p === '/api/places/import' && M === 'POST') {
      const b = await jsonBody(req); const list = b && Array.isArray(b.places) ? b.places : [];
      let n = 0;
      for (const x of list.slice(0, 2000)) {
        if (!x || !x.name || !isFinite(x.lat) || !isFinite(x.lng)) continue;
        const id = okId(x.id) ? x.id : crypto.randomBytes(9).toString('base64url');
        if (state.places[id]) continue;
        state.places[id] = { name: String(x.name).slice(0, 120), category: x.category || 'other', price: x.price ?? null, address: x.address || '', area: x.area || '',
          lat: +x.lat, lng: +x.lng, always: !!x.always, start: x.start || '', end: x.end || '', link: x.link || '', notes: x.notes || '', created: x.created || new Date().toISOString() };
        n++;
      }
      saveState(); return send(res, 200, { imported: n });
    }

    /* trips store (shared by everyone signed in) */
    if (p === '/api/state' && M === 'GET') return send(res, 200, state);
    m = /^\/api\/trips\/([^/]+)$/.exec(p);
    if (m && okId(m[1])) {
      const id = m[1];
      if (M === 'DELETE') { delete state.trips[id]; delete state.items[id]; saveState(); return send(res, 200, { ok: true }); }
      const body = await jsonBody(req); if (!body) return fail(res, 400, 'invalid_argument', 'Body must be an object');
      if (M === 'PUT') state.trips[id] = body;
      else if (M === 'PATCH') { if (!state.trips[id]) return fail(res, 404, 'invalid_argument', 'No such trip'); state.trips[id] = { ...state.trips[id], ...body }; }
      else return fail(res, 405, 'bad_request', 'Method not allowed');
      saveState(); return send(res, 200, { ok: true });
    }
    m = /^\/api\/trips\/([^/]+)\/items\/([^/]+)$/.exec(p);
    if (m && okId(m[1]) && okId(m[2])) {
      const [, t, id] = m; state.items[t] = state.items[t] || {};
      if (M === 'DELETE') { delete state.items[t][id]; saveState(); return send(res, 200, { ok: true }); }
      const body = await jsonBody(req); if (!body) return fail(res, 400, 'invalid_argument', 'Body must be an object');
      if (M === 'PUT') state.items[t][id] = body;
      else if (M === 'PATCH') { if (!state.items[t][id]) return fail(res, 404, 'invalid_argument', 'No such item'); state.items[t][id] = { ...state.items[t][id], ...body }; }
      else return fail(res, 405, 'bad_request', 'Method not allowed');
      saveState(); return send(res, 200, { ok: true });
    }
    if (p.startsWith('/api/')) return fail(res, 404, 'bad_request', 'Not found');

    if (M !== 'GET') return send(res, 405, 'Method not allowed');
    return serveStatic(res, p === '/' ? 'index.html' : p);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) p.startsWith('/api/') ? fail(res, 500, 'upstream_error', 'Server error') : send(res, 500, 'Server error');
  }
});
server.listen(PORT, () => console.log(`Itinerary Planner on :${PORT} · data ${DATA} · tz ${TZ} · users ${users.length} · google ${gcfg().clientId ? 'configured' : 'not configured'} · linked accounts ${Object.keys(google.accounts).length}`));
