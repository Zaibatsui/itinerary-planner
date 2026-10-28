// Place search (OpenStreetMap Nominatim) and routing (OSRM), proxied and cached so the browser
// gets one consistent API, Nominatim's 1-request-a-second rule is respected, and repeats are free.
'use strict';
const fs = require('node:fs');

const UA = 'ItineraryPlanner/1.0 (self-hosted trip planner)';
let geoCache = {}, routeCache = {}, file = null, saveT = null;
function init(dataFile) {
  file = dataFile;
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); geoCache = j.geo || {}; routeCache = j.route || {}; } catch {}
}
function persist() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const trim = o => Object.fromEntries(Object.entries(o).slice(-4000));
    try { fs.writeFileSync(file, JSON.stringify({ geo: trim(geoCache), route: trim(routeCache) })); } catch {}
  }, 2000);
}

// Nominatim allows one request per second: queue them
let chain = Promise.resolve(), last = 0;
const throttled = fn => (chain = chain.then(async () => { const wait = 1100 - (Date.now() - last); if (wait > 0) await new Promise(r => setTimeout(r, wait)); last = Date.now(); return fn(); }));

const areaOf = a => { a = a || {}; return a.suburb || a.neighbourhood || a.quarter || a.city_district || a.town || a.village || a.city || ''; };
// UK postcodes come from postcodes.io (Royal Mail / ONS data: every postcode, no key). OpenStreetMap only knows some of them.
const PC_FULL = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
const PC_PART = /^\s*([A-Z]{1,2}\d[A-Z\d]?)(\s*\d[A-Z]{0,1})?\s*$/i;
const PCIO = 'https://api.postcodes.io';
const pcResult = (r, label) => ({
  name: label || r.postcode, postcode: r.postcode,
  address: [label && label !== r.postcode ? label : '', r.postcode, r.admin_ward, r.admin_district, r.country].filter(Boolean).join(', '),
  area: r.admin_ward || r.parish || r.admin_district || '', lat: r.latitude, lng: r.longitude, precision: 'postcode'
});
async function postcodeSearch(q, limit) {
  const full = PC_FULL.exec(q);
  if (full) {
    const pc = (full[1] + ' ' + full[2]).toUpperCase();
    const r = await fetch(`${PCIO}/postcodes/${encodeURIComponent(pc)}`).then(x => x.json()).catch(() => null);
    if (!r || !r.result || r.result.latitude == null) {
      const t = await fetch(`${PCIO}/terminated_postcodes/${encodeURIComponent(pc)}`).then(x => x.json()).catch(() => null);
      return t && t.result && t.result.latitude != null ? [pcResult({ ...t.result, postcode: pc }, null)] : [];
    }
    // keep what was typed before the postcode ("12 Acacia Avenue") as the name
    const label = q.slice(0, full.index).replace(/[\s,]+$/, '').trim();
    return [pcResult(r.result, label || null)];
  }
  if (PC_PART.test(q) && /\d/.test(q)) {
    const ac = await fetch(`${PCIO}/postcodes/${encodeURIComponent(q.trim())}/autocomplete?limit=${limit}`).then(x => x.json()).catch(() => null);
    const list = (ac && ac.result) || [];
    if (list.length) {
      const bulk = await fetch(`${PCIO}/postcodes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ postcodes: list }) }).then(x => x.json()).catch(() => null);
      return ((bulk && bulk.result) || []).filter(x => x.result && x.result.latitude != null).map(x => pcResult(x.result, null));
    }
    const oc = await fetch(`${PCIO}/outcodes/${encodeURIComponent(q.trim())}`).then(x => x.json()).catch(() => null);
    if (oc && oc.result && oc.result.latitude != null) return [{ name: oc.result.outcode, address: [oc.result.outcode, (oc.result.admin_district || []).slice(0, 2).join(' / ')].filter(Boolean).join(', '), area: (oc.result.admin_district || [])[0] || '', lat: oc.result.latitude, lng: oc.result.longitude, precision: 'area' }];
  }
  return [];
}
async function search(q, limit = 5) {
  q = String(q || '').trim().slice(0, 200); if (q.length < 2) return [];
  const key = 's2|' + limit + '|' + q.toLowerCase();
  if (geoCache[key]) return geoCache[key];
  const [pc, osm] = await Promise.all([
    postcodeSearch(q, limit).catch(() => []),
    throttled(async () => {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=${limit}&q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB' } });
      if (!r.ok) throw new Error('Place search failed (' + r.status + ')');
      return (await r.json()).map(x => ({ name: x.name || x.display_name.split(',')[0], address: x.display_name, area: areaOf(x.address), lat: +x.lat, lng: +x.lon }));
    }).catch(e => { if (!PC_FULL.test(q)) throw e; return []; })
  ]);
  // an exact house match from OpenStreetMap beats the postcode's centre point; otherwise the postcode goes first
  const exactHouse = osm.find(x => /^\d/.test(q) && x.address && x.address.startsWith(q.split(/[\s,]/)[0]));
  const out = (exactHouse ? [exactHouse, ...pc, ...osm.filter(x => x !== exactHouse)] : [...pc, ...osm]).slice(0, Math.max(limit, pc.length));
  geoCache[key] = out; persist(); return out;
}
async function reverse(lat, lng) {
  const key = `r|${(+lat).toFixed(5)}|${(+lng).toFixed(5)}`;
  if (geoCache[key]) return geoCache[key];
  const out = await throttled(async () => {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB' } });
    const j = await r.json().catch(() => ({}));
    return { address: j.display_name || '', area: areaOf(j.address), name: j.name || '' };
  });
  geoCache[key] = out; persist(); return out;
}

// mode: foot | car | bike. coords: [[lat,lng], ...]
const ENGINES = {
  foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/',
  bike: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/',
  car: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/'
};
async function route(mode, coords) {
  const base = ENGINES[mode] || ENGINES.foot;
  const pts = coords.map(([la, ln]) => `${(+ln).toFixed(5)},${(+la).toFixed(5)}`).join(';');
  const key = mode + '|' + pts;
  if (routeCache[key]) return routeCache[key];
  const r = await fetch(`${base}${pts}?overview=full&geometries=geojson&steps=false`, { headers: { 'User-Agent': UA } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.routes || !j.routes.length) throw new Error(j.message || 'No route found');
  const best = j.routes[0];
  const out = { duration: best.duration, distance: best.distance, legs: (best.legs || []).map(l => ({ duration: l.duration, distance: l.distance })), geometry: best.geometry };
  routeCache[key] = out; persist(); return out;
}

// Public transport journeys anywhere Transitous has timetables (trains, buses, metro, trams, ferries).
// Free for non-commercial use; results are cached so repeat views don't count against their fair-use limit.
// Transitous asks every app to identify itself with a contact; set CONTACT (email or website) or BASE_URL
const TUA = `ItineraryPlanner/1.0 (self-hosted personal trip planner; ${process.env.CONTACT || process.env.BASE_URL || 'no contact set'})`;
const transitCache = new Map();
let transitDay = new Date().toDateString(), transitCount = 0;
async function transit(from, to, timeIso, arriveBy) {
  const f = from.map(v => (+v).toFixed(5)).join(','), t = to.map(v => (+v).toFixed(5)).join(',');
  const when = new Date(timeIso); if (isNaN(when)) throw new Error('Bad time');
  const m5 = when.getUTCMinutes() + (when.getUTCSeconds() ? 1 : 0);   // leave no earlier than asked, arrive no later
  when.setUTCMinutes((arriveBy ? Math.floor(m5 / 5) : Math.ceil(m5 / 5)) * 5, 0, 0);
  const key = [f, t, when.toISOString(), arriveBy ? 1 : 0].join('|');
  const hit = transitCache.get(key); if (hit && hit.at > Date.now() - 6 * 3600e3) return hit.v;
  if (new Date().toDateString() !== transitDay) { transitDay = new Date().toDateString(); transitCount = 0; }
  if (++transitCount > 700) throw new Error('Daily public transport lookup limit reached; try again tomorrow');
  const url = `https://api.transitous.org/api/v5/plan?fromPlace=${f}&toPlace=${t}&time=${encodeURIComponent(when.toISOString())}${arriveBy ? '&arriveBy=true' : ''}`;
  const r = await fetch(url, { headers: { 'User-Agent': TUA } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j && (j.message || j.error)) || 'Public transport search failed (' + r.status + ')');
  const pt = x => ({ name: x.name, lat: x.lat, lng: x.lon, track: x.track || x.scheduledTrack || '' });
  const v = { options: (j.itineraries || []).slice(0, 5).map(it => ({
    dur: it.duration, start: it.startTime, end: it.endTime, transfers: it.transfers || 0,
    legs: it.legs.map(l => ({
      mode: l.mode, from: pt(l.from), to: pt(l.to), start: l.startTime, end: l.endTime, dur: l.duration, dist: l.distance || 0,
      line: l.routeShortName || l.displayName || '', long: l.routeLongName || '', color: l.routeColor || '', text: l.routeTextColor || '',
      agency: l.agencyName || '', headsign: l.headsign || '', trip: l.tripShortName || '', realTime: !!l.realTime,
      stops: (l.intermediateStops || []).map(s => s.name),
      geo: l.legGeometry ? { p: l.legGeometry.points, prec: l.legGeometry.precision || 6 } : null
    }))
  })) };
  transitCache.set(key, { at: Date.now(), v });
  if (transitCache.size > 2000) transitCache.delete(transitCache.keys().next().value);
  return v;
}
module.exports = { init, search, reverse, route, transit };
