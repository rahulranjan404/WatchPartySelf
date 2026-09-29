// Holds the WebSocket + room state. Popup and content scripts talk to this.
const SERVER = 'wss://watchpartyself.onrender.com'; // change to wss://your-server when deployed

let ws = null, cid = null, keep = null, curUrl = '', myName = '';
let S = { room: null, me: null, members: [] };

const ready = (async () => {
  const d = await chrome.storage.local.get(['cid', 'room', 'name']);
  cid = d.cid;
  if (!cid) { cid = crypto.randomUUID(); await chrome.storage.local.set({ cid }); }
  myName = d.name || '';
  S.room = d.room || null;
  if (S.room) { try { await refreshUrl(); } catch (e) {} connect(); }
})();

const view = () => ({ ...S, connected: !!(ws && ws.readyState === 1), url: curUrl, name: myName });
const tx = m => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

function connect() {
  if (ws && ws.readyState < 2) return;
  ws = new WebSocket(SERVER);
  ws.onopen = () => {
    if (S.room) tx({ t: 'join', cid, room: S.room, url: curUrl, name: myName }); // auto-rejoin
    clearInterval(keep);
    keep = setInterval(() => tx({ t: 'ping' }), 20000); // keeps the service worker alive
    push();
  };
  ws.onmessage = e => onServer(JSON.parse(e.data));
  ws.onclose = () => { clearInterval(keep); push(); if (S.room) setTimeout(connect, 3000); };
}

function whenOpen(cb) {
  if (ws && ws.readyState === 1) return cb();
  connect();
  ws.addEventListener('open', cb, { once: true });
}

const toPopup = m => chrome.runtime.sendMessage(m).catch(() => {});
function toTabs(m) {
  chrome.tabs.query({}).then(tabs => tabs
    .filter(t => /youtube\.com/.test(t.url || ''))
    .forEach(t => chrome.tabs.sendMessage(t.id, m).catch(() => {})));
}
function push() { toPopup({ t: 'S', S: view() }); toTabs({ t: 'S', S: view() }); }

function onServer(m) {
  if (m.t === 'joined') {
    S = { room: m.room, me: m.me, members: m.members };
    chrome.storage.local.set({ room: m.room });
    push();
  } else if (m.t === 'members') {
    S.members = m.members; push();
  } else if (m.t === 'error') {
    if (m.gone) { S = { room: null, me: null, members: [] }; chrome.storage.local.remove('room'); push(); }
    toPopup({ t: 'error', msg: m.msg });
  } else {
    toTabs(m); // ev, sync, hold, release, chat
  }
}

// Report what the user is currently looking at (active tab of the focused normal window)
async function refreshUrl() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  if (!t || !t.url) return;
  if (/^(devtools|chrome-extension):/.test(t.url)) return; // ignore DevTools / extension pages
  if (t.url !== curUrl) { curUrl = t.url; tx({ t: 'url', url: curUrl }); }
}
chrome.tabs.onActivated.addListener(refreshUrl);
chrome.tabs.onUpdated.addListener((id, info, tab) => { if ((info.url || info.status) && tab.active) refreshUrl(); });
chrome.tabs.onRemoved.addListener(() => setTimeout(refreshUrl, 100));
chrome.windows.onFocusChanged.addListener(id => {
  if (id !== chrome.windows.WINDOW_ID_NONE) refreshUrl();
});

function leave() {
  tx({ t: 'leave' });
  S = { room: null, me: null, members: [] };
  chrome.storage.local.remove('room');
  if (ws) ws.close();
  push();
}

chrome.runtime.onMessage.addListener((m, sender, res) => {
  ready.then(async () => {
    switch (m.t) {
      case 'setname':
        myName = String(m.name || '').trim().slice(0, 20);
        chrome.storage.local.set({ name: myName });
        if (S.room) tx({ t: 'name', name: myName });
        push();
        break;
      case 'create':
        if (S.room) leave();
        await refreshUrl();
        whenOpen(() => tx({ t: 'create', cid, url: curUrl, name: myName }));
        break;
      case 'join':
        if (S.room) leave();
        await refreshUrl();
        whenOpen(() => tx({ t: 'join', cid, room: String(m.room).trim().toLowerCase(), url: curUrl, name: myName }));
        break;
      case 'leave': leave(); break;
      case 'startover': tx({ t: 'ev', a: 'startover', time: 0 }); break;
      case 'ev': case 'buf': case 'chat': case 'resync': case 'ad':
        if (S.room) whenOpen(() => tx(m)); // waits for (re)connect instead of dropping
        break;
      case 'pos': tx(m); break; // answer to the periodic sync check
      case 'hb': // heartbeat from the video tab: wakes the worker, reconnects, refreshes URL
        await refreshUrl();
        if (S.room && !(ws && ws.readyState < 2)) connect();
        break;
    }
    res(view());
  });
  return true;
});