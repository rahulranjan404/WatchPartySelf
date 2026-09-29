// WatchParty sync server. Run: npm install && npm start
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

// Plain HTTP page: open this URL in a browser to wake the server up before movie time.
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WatchParty server</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0e11;color:#f3f4f6;font-family:system-ui,'Segoe UI',sans-serif;text-align:center">
<div><div style="width:14px;height:14px;border-radius:50%;background:#2ee6b8;box-shadow:0 0 16px #2ee6b8;margin:0 auto 18px"></div>
<h1 style="margin:0 0 8px">WatchParty server is awake</h1>
<p style="color:#8a8f9c;margin:0">You can now create or join a room from the extension.<br>Active rooms: ${rooms.size}</p></div></body>`);
});
const wss = new WebSocketServer({ server: httpServer, maxPayload: 10 * 1024 });
const rooms = new Map();
// no red/green shades: those are reserved for online/offline borders
const COLORS = ['#ff9800', '#03a9f4', '#9c27b0', '#e91e63', '#00bcd4', '#ffeb3b', '#795548', '#607d8b'];
const CH = 'abcdefghjkmnpqrstuvwxyz23456789';
const genId = (n = 6) => Array.from({ length: n }, () => CH[crypto.randomInt(CH.length)]).join('');
const PROBE_MS = Number(process.env.PROBE_MS) || 60000; // how often to check that everyone is in sync
const DRIFT_S = 1.5;                                     // allowed difference in seconds
const cleanName = n => String(n || '').trim().slice(0, 20) || 'Guest';

// Which "video" a URL points to. Two members are in sync only if keys match.
function keyOf(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return '';
    const h = x.hostname.replace(/^www\.|^m\./, '');
    if (h === 'youtube.com') {
      if (x.pathname === '/watch') return 'yt:' + x.searchParams.get('v');
      const s = x.pathname.match(/^\/(shorts|live|embed)\/([^/]+)/);
      if (s) return 'yt:' + s[2];
    }
    if (h === 'youtu.be') return 'yt:' + x.pathname.slice(1);
    return h + x.pathname.replace(/\/$/, '');
  } catch { return ''; }
}

const isOn = (r, m) => !!m.ws && !!m.key && m.key === r.key;
const pub = r => [...r.members.values()].map(m => ({
  id: m.id, name: m.name, color: m.color, host: m.cid === r.host, online: isOn(r, m), url: m.url,
  ad: !!m.ad, buf: !!m.buf,
}));
const send = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
// to members on the room's video (or to everyone connected if all=true)
const cast = (r, o, except, all) =>
  r.members.forEach(m => { if (m !== except && (all ? m.ws : isOn(r, m))) send(m.ws, o); });
const sendMembers = r => cast(r, { t: 'members', members: pub(r) }, null, true);
const est = r => r.time + (r.playing && !r.blocked ? (Date.now() - r.t) / 1000 : 0); // time freezes while someone is in an ad / buffering
const sendSync = (r, m) => r.has && send(m.ws, { t: 'sync', playing: r.playing, time: est(r) });

// Someone buffering or watching an ad => everyone else waits. When nobody is, everyone resumes.
function recompute(r) {
  const on = [...r.members.values()].filter(x => isOn(r, x));
  const blockers = on.filter(x => x.ad || x.buf);
  const blocked = blockers.length > 0;
  if (blocked !== r.blocked) { r.time = est(r); r.t = Date.now(); r.blocked = blocked; }
  on.forEach(x => {
    const need = blockers.some(b => b !== x);
    if (need && !x.held) { x.held = true; send(x.ws, { t: 'hold', playing: r.has ? r.playing : null }); }
    else if (!need && x.held) { x.held = false; send(x.ws, { t: 'release' }); }
  });
  r.members.forEach(x => { if (!isOn(r, x)) x.held = false; });
  sendMembers(r);
}

function pickColor(r) {
  const used = new Set([...r.members.values()].map(m => m.color));
  const free = COLORS.filter(c => !used.has(c));
  const pool = free.length ? free : COLORS;
  return pool[crypto.randomInt(pool.length)];
}

// returns true if the member just arrived on the room's video
function setUrl(r, m, url) {
  const was = isOn(r, m);
  m.url = String(url || '').slice(0, 500);
  m.key = keyOf(m.url);
  if (m.cid === r.host && m.key && m.key !== r.key) { // host moved to another video
    r.key = m.key; r.has = false; r.playing = false; r.time = 0; r.blocked = false;
    r.members.forEach(x => { x.ad = x.buf = x.held = false; });
  }
  if (was && !isOn(r, m)) m.ad = m.buf = m.held = false;
  console.log(`[url] room=${r.id} ${m.name} ${m.cid === r.host ? '(host)' : ''} key=${m.key || '(none)'} roomKey=${r.key} online=${isOn(r, m)}`);
  return !was && isOn(r, m);
}

function enter(ws, d) {
  if (ws.room || typeof d.cid !== 'string' || !d.cid) return;
  let r;
  if (d.t === 'create') {
    if (rooms.size >= 500) return send(ws, { t: 'error', msg: 'Server is full, try again later' });
    let id; do { id = genId(); } while (rooms.has(id));
    r = { id, host: d.cid, key: keyOf(d.url), members: new Map(), blocked: false, probe: null,
          playing: false, time: 0, t: Date.now(), has: false, timer: null };
    rooms.set(id, r);
  } else {
    r = rooms.get(String(d.room || '').toLowerCase());
    if (!r) return send(ws, { t: 'error', msg: 'Room not found', gone: true });
  }
  clearTimeout(r.timer);
  let m = r.members.get(d.cid);
  if (!m) {
    m = { id: genId(4), cid: d.cid, name: cleanName(d.name), color: pickColor(r), url: '', key: '', ws: null };
    r.members.set(d.cid, m);
  } else if (d.name) m.name = cleanName(d.name);
  if (m.ws && m.ws !== ws) { m.ws.room = m.ws.member = null; m.ws.close(); }
  m.ws = ws; ws.room = r; ws.member = m;
  m.ad = m.buf = m.held = false;
  const arrived = setUrl(r, m, d.url);
  send(ws, { t: 'joined', room: r.id, me: { id: m.id, color: m.color }, members: pub(r) });
  recompute(r);
  if (arrived) sendSync(r, m);
}

const handlers = {
  create: enter,
  join: enter,
  name(ws, d, r, m) { m.name = cleanName(d.name); sendMembers(r); },
  url(ws, d, r, m) {
    const arrived = setUrl(r, m, d.url);
    recompute(r);
    if (arrived) sendSync(r, m);
  },
  resync(ws, d, r, m) { if (isOn(r, m)) sendSync(r, m); },
  ev(ws, d, r, m) {
    console.log(`[ev] room=${r.id} ${d.a} from ${m.name} online=${isOn(r, m)}`);
    if (!isOn(r, m)) return;
    const a = d.a, time = Number(d.time) || 0;
    if (a === 'startover') {
      r.has = true; r.playing = true; r.time = 0; r.t = Date.now();
      return cast(r, { t: 'ev', a, time: 0, from: m.color, name: m.name, id: m.id }, null); // everyone, incl. sender
    }
    if (!['play', 'pause', 'seek'].includes(a)) return;
    r.has = true; r.time = time; r.t = Date.now();
    if (a === 'play') r.playing = true;
    if (a === 'pause') r.playing = false;
    cast(r, { t: 'ev', a, time, from: m.color, name: m.name, id: m.id }, m);
  },
  buf(ws, d, r, m) {
    if (!isOn(r, m)) return;
    m.buf = !!d.on;
    recompute(r);
  },
  ad(ws, d, r, m) { // member started / finished watching an ad
    if (!isOn(r, m)) return;
    m.ad = !!d.on;
    recompute(r);
    if (!d.on) sendSync(r, m); // put them back on the right time after their ad
  },
  pos(ws, d, r, m) { // answer to a sync probe
    if (r.probe && r.probe.pid === d.pid && d.ok)
      r.probe.reps.set(m.id, { time: Number(d.time) || 0, playing: !!d.playing, at: Date.now() });
  },
  chat(ws, d, r, m) {
    const now = Date.now();
    if (now - (m.lastChat || 0) < 300) return; // basic rate limit
    m.lastChat = now;
    const text = String(d.text || '').trim().slice(0, 200);
    if (text) cast(r, { t: 'chat', id: m.id, name: m.name, color: m.color, text }, null, true);
  },
  leave(ws, d, r, m) {
    r.members.delete(m.cid);
    ws.room = ws.member = null;
    if (!r.members.size) return rooms.delete(r.id);
    if (r.host === m.cid) r.host = r.members.keys().next().value;
    recompute(r);
  },
  ping() {},
};

wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
  ws.on('message', raw => {
    ws.alive = true;
    let d; try { d = JSON.parse(raw); } catch { return; }
    const h = handlers[d && d.t];
    if (!h) return;
    if (d.t === 'create' || d.t === 'join') return h(ws, d);
    if (ws.room && ws.member) h(ws, d, ws.room, ws.member);
  });
  ws.on('close', () => {
    const r = ws.room, m = ws.member;
    if (!r || !m || m.ws !== ws) return;
    m.ws = null;
    m.ad = m.buf = m.held = false;
    recompute(r);
    if (![...r.members.values()].some(x => x.ws)) r.timer = setTimeout(() => rooms.delete(r.id), 10 * 60 * 1000);
  });
});

// ---- periodic sync check: whoever is ahead gets moved back to the one who is behind ----
let pidN = 0;
function probe(r) {
  const on = [...r.members.values()].filter(x => isOn(r, x));
  if (on.length < 2 || r.blocked) return;
  const pid = ++pidN;
  r.probe = { pid, reps: new Map() };
  cast(r, { t: 'probe', pid }, null);
  setTimeout(() => resolveProbe(r, pid), 1500);
}
function resolveProbe(r, pid) {
  if (!r.probe || r.probe.pid !== pid) return;
  const reps = r.probe.reps;
  r.probe = null;
  if (r.blocked || reps.size < 2) return;
  const now = Date.now();
  const list = [...reps].map(([id, v]) => ({ id, time: v.time + (v.playing ? (now - v.at) / 1000 : 0) }));
  const min = list.reduce((a, b) => (b.time < a.time ? b : a));
  const byId = id => [...r.members.values()].find(x => x.id === id);
  const behind = byId(min.id);
  list.forEach(x => {
    const ahead = x.time - min.time;
    if (ahead > DRIFT_S) {
      const m = byId(x.id);
      console.log(`[sync] room=${r.id} ${m.name} was ${ahead.toFixed(1)}s ahead of ${behind.name}`);
      if (m) send(m.ws, { t: 'drift', time: min.time, ahead, name: behind.name, color: behind.color });
    }
  });
}
setInterval(() => rooms.forEach(probe), PROBE_MS);

setInterval(() => wss.clients.forEach(ws => {
  if (!ws.alive) return ws.terminate();
  ws.alive = false; ws.ping();
}), 30000);

httpServer.listen(PORT, '0.0.0.0', () => console.log('WatchParty server on port', PORT));