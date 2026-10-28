// Finds booking confirmations in Gmail whose event date falls on one of the trip's days.
'use strict';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON_RX = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DAY_RX = '(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\\.?,?\\s+)?';
const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

const SEARCH = [
  'newer_than:1y', '-in:chats', '-category:promotions', '-category:social', '-from:calendar-notification@google.com', '-filename:invite.ics',
  '{subject:booking subject:booked subject:confirmation subject:confirmed subject:tickets subject:ticket subject:e-ticket subject:reservation subject:order subject:itinerary subject:receipt category:reservations category:purchases}'
].join(' ');

/* ---------- message text ---------- */
const b64 = s => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function htmlToText(h) {
  return String(h)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table|td)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&pound;/g, '£')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function bodyText(payload) {
  let plain = '', html = '';
  const walk = p => {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body && p.body.data) plain += b64(p.body.data) + '\n';
    else if (p.mimeType === 'text/html' && p.body && p.body.data) html += b64(p.body.data) + '\n';
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  const t = plain.trim() ? plain : htmlToText(html);
  return t.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').slice(0, 30000);
}
const header = (m, n) => ((m.payload && m.payload.headers) || []).find(h => h.name.toLowerCase() === n)?.value || '';

/* ---------- extraction ---------- */
// dates without a year get the first matching date on or after the email arrived (less a week of slack);
// anything that lands before this year is ignored, so old trips' emails never match a new trip's days
function findDates(text, received) {
  const out = [], recv = received instanceof Date && !isNaN(received) ? received : new Date();
  const thisYear = new Date().getFullYear();
  const push = (y, m, d, idx, len) => {
    m = +m; d = +d;
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    if (y == null || y === '') {
      y = recv.getFullYear();
      if (new Date(y, m - 1, d) < new Date(+recv - 7 * 864e5)) y += 1;
    } else { y = +y; if (y < 100) y += 2000; }
    if (y < thisYear) return;
    out.push({ date: ymd(y, m, d), idx, end: idx + len });
  };
  let r;
  const rx1 = /\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{4}|\d{2})\b/g;                 // 19/11/2026 (UK order)
  while ((r = rx1.exec(text))) push(r[3], r[2], r[1], r.index, r[0].length);
  const rx2 = /\b(\d{4})-(\d{2})-(\d{2})\b/g;                                   // 2026-11-19
  while ((r = rx2.exec(text))) push(r[1], r[2], r[3], r.index, r[0].length);
  const rx3 = new RegExp('\\b' + DAY_RX + '(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + MON_RX + ',?(?:\\s+(\\d{4}))?', 'gi'); // Thursday, 19 November, 2026
  while ((r = rx3.exec(text))) push(r[3], MONTHS.indexOf(r[2].slice(0, 3).toLowerCase()) + 1, r[1], r.index, r[0].length);
  const rx4 = new RegExp('\\b' + DAY_RX + MON_RX + '\\s+(\\d{1,2})(?:st|nd|rd|th)?,?(?:\\s+(\\d{4}))?', 'gi');           // November 19, 2026
  while ((r = rx4.exec(text))) push(r[3], MONTHS.indexOf(r[1].slice(0, 3).toLowerCase()) + 1, r[2], r.index, r[0].length);
  return out.sort((a, b) => a.idx - b.idx);
}
function timeNear(text, from) {
  const win = text.slice(from, from + 70);
  const m = /\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b/i.exec(win);
  if (!m) return null;
  let h = +(m[1] || m[4]), min = +(m[2] || 0); const ap = (m[3] || m[5] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}
const GENERIC = /order|confirm|booking|booked|ticket|receipt|reservation|your |thank|e-?mail|invoice|itinerary|not your|^\s*(re|fwd?|fw)\b/i;
function titleFrom(subject, from) {
  let s = subject.replace(/^\s*((fwd?|fw|re)\s*:\s*)+/i, '').trim();
  const parts = s.split(/\s+[-–|•]\s+|:\s+/).map(x => x.trim()).filter(Boolean);
  const good = parts.find(p => !GENERIC.test(p) && !/\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}/.test(p) && p.length > 1 && p.length < 60);
  if (good) return good;
  const sender = (from.match(/^\s*"?([^"<]+)"?\s*</) || [])[1] || from.split('@')[0];
  return (sender.trim().replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + ' booking').slice(0, 70);
}
const VENUE_RX = /(theatre|theater|hotel|restaurant|station|airport|arena|museum|gallery|venue|hall|stadium|cinema|inn|lodge|terminal|pier|centre|center|club|bar|kitchen|cafe|café)/i;
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/;
function venueNear(text, at) {
  const lines = text.split('\n');
  let pos = 0, best = null, bestDist = Infinity;
  for (const raw of lines) {
    const line = raw.trim(); const start = pos; pos += raw.length + 1;
    if (!line || line.length > 90 || /https?:|@|unsubscribe|terms|privacy|newsletter|^\[image|^\[cid|logo/i.test(line)) continue;
    if (!(VENUE_RX.test(line) || POSTCODE.test(line))) continue;
    const dist = Math.abs(start - at);
    if (dist < bestDist && dist < 2500) { best = line; bestDist = dist; }
  }
  return best ? best.replace(/^[\s*•\-–]+|[\s*]+$/g, '').replace(/<[^>]*>/g, '').slice(0, 90) : '';
}
const REF_RX = /\b(?:order|booking|confirmation|reservation|reference|ref|pnr|ticket)\s*(?:id|no\.?|number|code|ref(?:erence)?)?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9-]{4,15})\b/gi;
function refFrom(subject, text) {
  for (const src of [subject, text.slice(0, 8000)]) {
    for (const m of src.matchAll(REF_RX)) {
      const v = m[1];
      if (/\d/.test(v) && /[A-Z]/.test(v) === /[A-Za-z]/.test(v) && !/^\d{1,2}[\/.]/.test(v)) return v;   // needs a digit; letters must be capitals
      if (/^\d{6,15}$/.test(v)) return v;
    }
  }
  return '';
}

/* ---------- scan ---------- */
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } } }));
  return out;
}
const cache = new Map();

async function scanAccount(account, token, days) {
  const daySet = new Set(days);
  const key = account.id + '|' + days.join(',');
  const hit = cache.get(key); if (hit && hit.at > Date.now() - 10 * 60 * 1000) return hit.list;
  const H = { authorization: 'Bearer ' + token };
  const lr = await fetch(`${GMAIL}/messages?maxResults=150&q=${encodeURIComponent(SEARCH)}`, { headers: H });
  const lj = await lr.json().catch(() => ({}));
  if (!lr.ok) { const e = new Error((lj.error && lj.error.message) || 'Gmail returned ' + lr.status); e.status = lr.status; throw e; }
  const ids = (lj.messages || []).map(m => m.id);
  const msgs = await pool(ids, 8, async id => { const r = await fetch(`${GMAIL}/messages/${id}?format=full`, { headers: H }); return r.ok ? r.json() : null; });
  const found = [];
  for (const m of msgs) {
    if (!m) continue;
    const subject = header(m, 'subject'), from = header(m, 'from');
    // calendar invitations are already on someone's calendar, so they aren't bookings to suggest
    if (/^\s*((fwd?|fw|re)\s*:\s*)*(updated\s+)?(invitation|accepted|declined|tentatively accepted|new event|event)\s*(:|from)/i.test(subject) || /calendar-notification@google\.com/i.test(from)) continue;
    const text = bodyText(m.payload), recv = new Date(+m.internalDate || Date.now());
    const subjDates = findDates(subject, recv).filter(d => daySet.has(d.date));
    const bodyDates = findDates(text, recv).filter(d => daySet.has(d.date));
    const pick = subjDates[0] ? { ...subjDates[0], src: 'subject' } : bodyDates[0] ? { ...bodyDates[0], src: 'body' } : null;
    if (!pick) continue;
    const time = pick.src === 'subject' ? (timeNear(subject, pick.end) || (bodyDates[0] && timeNear(text, bodyDates[0].end))) : timeNear(text, pick.end);
    found.push({
      id: m.id, account: account.email,
      subject: subject.replace(/^\s*((fwd?|fw|re)\s*:\s*)+/i, '').slice(0, 160),
      from: from.replace(/<[^>]*>/, '').replace(/"/g, '').trim().slice(0, 80),
      received: new Date(+m.internalDate || Date.now()).toISOString(),
      title: titleFrom(subject, from), date: pick.date, start: time || null,
      location: venueNear(text, bodyDates[0] ? bodyDates[0].idx : 0),
      ref: refFrom(subject, text),
      link: `https://mail.google.com/mail/?authuser=${encodeURIComponent(account.email)}#all/${m.id}`
    });
  }
  cache.set(key, { at: Date.now(), list: found });
  return found;
}

// merge the same booking found in several inboxes (e.g. someone's original and the copy they forwarded)
function merge(all) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const byKey = new Map();
  for (const b of all.sort((a, c) => a.received.localeCompare(c.received))) {
    const k = norm(b.title) + '|' + b.date;
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, { ...b, accounts: [b.account], ids: [b.id] });
    else {
      prev.accounts = [...new Set([...prev.accounts, b.account])]; prev.ids.push(b.id);
      for (const f of ['start', 'location', 'ref']) if (!prev[f] && b[f]) prev[f] = b[f];
    }
  }
  return [...byKey.values()].sort((a, b) => (a.date + (a.start || '')).localeCompare(b.date + (b.start || '')));
}

module.exports = { findDates, scanAccount, merge, clearCache: () => cache.clear() };
