// Runs on YouTube pages: syncs the <video>, handles ads, and draws the overlay.
(() => {
  if (window.__wp) return;
  window.__wp = 1;

  const HIDE_MS = 12000;   // how long a chat message stays on screen
  const IDLE_MS = 6000;    // typing box closes after this much inactivity
  const QUIET_MS = 30000;  // silence longer than this => next incoming msg is shown big
  const TOAST_MS = 3500;   // how long action labels ("Rahul paused") stay

  let S = { room: null, me: null, members: [] };
  let video = null, quietUntil = 0, held = false, wasPlaying = false;
  let isBuf = false, bufTimer = null, inAd = false, announced = null;

  const send = m => { try { chrome.runtime.sendMessage(m).catch(() => {}); } catch (e) {} };
  const quiet = () => (quietUntil = Date.now() + 600); // ignore events we caused ourselves
  const isAd = () => !!document.querySelector('.html5-video-player.ad-showing');
  const live = () => Date.now() > quietUntil && S.room && !isAd();
  const fmt = s => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  };

  // ---------- video sync ----------
  setInterval(() => {
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (v && v !== video) { video = v; bind(v); send({ t: 'resync' }); }
  }, 1000);

  function bind(v) {
    v.addEventListener('play', () => live() && send({ t: 'ev', a: 'play', time: v.currentTime }));
    v.addEventListener('pause', () => {
      if (isBuf) endBuf();
      if (live() && !v.ended) send({ t: 'ev', a: 'pause', time: v.currentTime });
    });
    v.addEventListener('seeked', () => live() && send({ t: 'ev', a: 'seek', time: v.currentTime }));
    v.addEventListener('waiting', () => {
      if (!live() || v.paused) return;
      clearTimeout(bufTimer);
      bufTimer = setTimeout(() => { isBuf = true; send({ t: 'buf', on: true }); }, 400);
    });
    v.addEventListener('playing', endBuf);
    v.addEventListener('canplay', endBuf);
  }
  function endBuf() {
    clearTimeout(bufTimer);
    if (isBuf) { isBuf = false; send({ t: 'buf', on: false }); }
  }

  // ---------- ads ----------
  setInterval(() => {
    const a = isAd();
    if (a === inAd) return;
    inAd = a;
    if (S.room) send({ t: 'ad', on: a });
    if (!a) [150, 600, 1200].forEach(ms => setTimeout(() => { // keep paused if others are still in their ad
      if (held && video && !isAd()) { quiet(); video.pause(); }
    }, ms));
  }, 400);

  // ---------- applying remote actions ----------
  function go(a, t) {
    if (!video) return;
    if (isAd()) { // never touch the player during our own ad; the server re-syncs us afterwards
      if (held) wasPlaying = a === 'play' || a === 'startover' ? true : a === 'pause' ? false : wasPlaying;
      return;
    }
    quiet();
    if (a === 'startover') {
      video.currentTime = 0;
      if (held) wasPlaying = true; else video.play().catch(() => {});
      return;
    }
    if (typeof t === 'number' && Math.abs(video.currentTime - t) > 0.7) video.currentTime = t;
    if (a === 'play') { if (held) wasPlaying = true; else if (video.paused) video.play().catch(() => {}); }
    if (a === 'pause') { if (held) wasPlaying = false; else if (!video.paused) video.pause(); }
  }

  function onHold(m) { // someone is buffering or in an ad: wait for them
    if (!video) return;
    if (!held) { held = true; wasPlaying = isAd() ? m.playing !== false : !video.paused; }
    if (!isAd()) { quiet(); video.pause(); }
    updateWait();
  }
  function onRelease() {
    if (held) {
      held = false;
      if (wasPlaying && video && !isAd()) { quiet(); video.play().catch(() => {}); }
    }
    updateWait();
  }

  chrome.runtime.onMessage.addListener(m => {
    if (m.t === 'S') { S = m.S; render(); }
    else if (m.t === 'ev') { evToast(m); go(m.a, m.time); }
    else if (m.t === 'sync') go(m.playing ? 'play' : 'pause', m.time);
    else if (m.t === 'chat') addMsg(m);
    else if (m.t === 'hold') onHold(m);
    else if (m.t === 'release') onRelease();
    else if (m.t === 'probe') { // periodic sync check: report where we are
      send({ t: 'pos', pid: m.pid, time: video ? video.currentTime : 0,
             playing: !!video && !video.paused, ok: !!video && !isAd() && !held });
    } else if (m.t === 'drift') { // we are ahead of someone: move back to them
      if (!video || isAd() || held) return;
      quiet();
      video.currentTime = m.time;
      toast(m.color, `Synced: moved back ${Math.round(m.ahead)}s to match ${m.name}`);
    }
  });

  // ---------- overlay ----------
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:none';
  const sh = host.attachShadow({ mode: 'open' });
  sh.innerHTML = `
  <style>
    *{box-sizing:border-box}
    #bar{position:absolute;top:14px;left:18px;display:flex;gap:12px;align-items:center;color:#fff;
      font:600 12px system-ui,'Segoe UI',sans-serif;background:rgba(15,15,25,.55);
      backdrop-filter:blur(8px);padding:6px 14px 6px 8px;border-radius:24px;
      border:1px solid rgba(255,255,255,.14)}
    #dots{display:flex;gap:6px}
    .d{width:26px;height:26px;border-radius:50%;border:3px solid #2ecc71;display:flex;
      align-items:center;justify-content:center;font:700 12px system-ui,sans-serif;color:#fff;
      text-shadow:0 1px 2px rgba(0,0,0,.7)}
    .d.off{border-color:#e74c3c;opacity:.8}

    #sys{position:absolute;top:62px;left:18px;display:flex;flex-direction:column;gap:6px;align-items:flex-start}
    .t,.w{display:flex;align-items:center;gap:8px;color:#fff;font:600 12px system-ui,'Segoe UI',sans-serif;
      background:rgba(15,15,25,.72);backdrop-filter:blur(6px);padding:6px 12px;border-radius:20px;
      border:1px solid rgba(255,255,255,.12);animation:in .25s}
    .t i{width:9px;height:9px;border-radius:50%;background:var(--c);flex:none}
    .t.out{animation:out .4s forwards}
    .w{display:none;border-color:rgba(255,176,58,.6);color:#ffd08a}
    .w::before{content:"";width:9px;height:9px;border-radius:50%;background:#ffb03a;flex:none;animation:pulse 1.2s infinite}
    @keyframes pulse{50%{opacity:.25}}

    #msgs{position:absolute;left:18px;bottom:120px;display:flex;flex-direction:column;gap:8px;
      max-width:42%;align-items:flex-start}
    .m{background:rgba(15,15,25,.74);backdrop-filter:blur(6px);color:#fff;
      font:14px/1.35 system-ui,'Segoe UI',sans-serif;padding:7px 12px;border-radius:12px;
      border-left:5px solid var(--c);word-break:break-word;animation:in .25s}
    .m b{color:var(--c);margin-right:6px}
    .m.big{font-size:22px;padding:14px 20px;border-radius:16px;border-left-width:8px;
      box-shadow:0 0 0 2px var(--c),0 8px 30px rgba(0,0,0,.55);
      animation:pop .45s cubic-bezier(.2,1.4,.4,1)}
    .m.out{animation:out .5s forwards}
    @keyframes in{from{opacity:0;transform:translateY(8px)}}
    @keyframes pop{0%{opacity:0;transform:scale(.6) translateY(20px)}100%{opacity:1;transform:none}}
    @keyframes out{to{opacity:0;transform:translateY(-6px)}}
    #inp{display:none;position:absolute;left:18px;bottom:66px;width:360px;padding:10px 14px;
      border-radius:12px;border:2px solid var(--me,#fff);background:rgba(15,15,25,.92);color:#fff;
      font:14px system-ui,'Segoe UI',sans-serif;pointer-events:auto;outline:none;
      box-shadow:0 6px 24px rgba(0,0,0,.5)}
  </style>
  <div id="bar"><div id="dots"></div><span id="hint">Alt+T to type</span></div>
  <div id="sys"><div id="wait" class="w"></div></div>
  <div id="msgs"></div>
  <input id="inp" maxlength="200" placeholder="Type a message...">`;
  const $ = id => sh.getElementById(id);
  const inp = $('inp');

  function mount() {
    const p = document.fullscreenElement || document.documentElement;
    if (host.parentNode !== p) p.appendChild(host);
  }
  document.addEventListener('fullscreenchange', mount);

  function render() {
    host.style.display = S.room ? 'block' : 'none';
    mount();
    if (S.me) inp.style.setProperty('--me', S.me.color);
    if (!S.room) announced = null;
    else if (inAd && announced !== S.room) { announced = S.room; send({ t: 'ad', on: true }); }
    const dots = $('dots');
    dots.innerHTML = '';
    S.members.forEach(m => {
      const d = document.createElement('div');
      d.className = 'd' + (m.online ? '' : ' off');
      d.style.background = m.color;
      d.textContent = (m.name || '?').trim().charAt(0).toUpperCase();
      const me = S.me && m.id === S.me.id;
      d.title = (m.name || 'Guest') + (m.host ? ' (host)' : '') + (me ? ' (you)' : '') + (m.online ? ' - online' : ' - offline');
      dots.appendChild(d);
    });
    updateWait();
  }

  // ---------- labels: who did what, who is in an ad / buffering ----------
  function toast(color, text) {
    const sys = $('sys');
    const el = document.createElement('div');
    el.className = 't';
    el.style.setProperty('--c', color || '#fff');
    el.append(document.createElement('i'), document.createTextNode(text));
    sys.appendChild(el);
    while (sys.querySelectorAll('.t').length > 4) sys.querySelector('.t').remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 450); }, TOAST_MS);
  }

  function evToast(m) {
    const who = S.me && m.id === S.me.id ? 'You' : (m.name || 'Someone');
    const what = { play: 'played', pause: 'paused', seek: 'jumped to ' + fmt(m.time), startover: 'restarted the video' }[m.a];
    if (what) toast(m.from, `${who} ${what}`);
  }

  function updateWait() { // sticky label while someone else is in an ad or buffering
    const w = $('wait');
    const others = S.me ? S.members.filter(m => m.online && m.id !== S.me.id && (m.ad || m.buf)) : [];
    if (!S.room || !others.length) { w.style.display = 'none'; return; }
    w.textContent = others.map(m => `${m.name || 'Guest'} is ${m.ad ? 'watching an ad' : 'buffering'}`).join(' · ')
      + (held ? ' — waiting' : '');
    w.style.display = 'flex';
  }

  // ---------- chat messages ----------
  let history = [], lastChatAt = 0, typing = false, idleT = null;

  function makeEl(e) {
    const d = document.createElement('div');
    d.className = 'm' + (e.big ? ' big' : '');
    d.style.setProperty('--c', e.color);
    const b = document.createElement('b');
    b.textContent = e.name + ':';
    d.append(b, document.createTextNode(e.text));
    return d;
  }
  function fade(el) { el.classList.add('out'); setTimeout(() => el.remove(), 600); }

  function addMsg(m) {
    const now = Date.now();
    const mine = S.me && m.id === S.me.id;
    const e = { color: m.color, name: m.name || 'Guest', text: m.text, big: !mine && now - lastChatAt > QUIET_MS };
    lastChatAt = now;
    history.push(e);
    if (history.length > 50) history.shift();
    const msgs = $('msgs');
    const el = makeEl(e);
    msgs.appendChild(el);
    if (!typing) el._t = setTimeout(() => fade(el), HIDE_MS); // while typing, messages stay pinned
    while (msgs.children.length > 8) msgs.firstChild.remove();
  }

  // ---------- Alt+T typing box ----------
  function bump() { clearTimeout(idleT); idleT = setTimeout(closeInput, IDLE_MS); }

  function openInput() {
    if (typing) { inp.focus(); bump(); return; }
    typing = true;
    const msgs = $('msgs');
    msgs.innerHTML = '';
    history.slice(-5).forEach(e => msgs.appendChild(makeEl({ ...e, big: false }))); // last 5 messages
    inp.style.display = 'block';
    inp.focus();
    $('hint').textContent = 'Enter to send · Esc to close';
    bump();
  }

  function closeInput() {
    if (!typing) return;
    typing = false;
    clearTimeout(idleT);
    inp.style.display = 'none';
    inp.value = '';
    inp.blur();
    $('hint').textContent = 'Alt+T to type';
    Array.from($('msgs').children).forEach(el => { el._t = setTimeout(() => fade(el), 3000); });
  }

  window.addEventListener('keydown', e => {
    if (e.altKey && e.code === 'KeyT' && S.room) {
      e.preventDefault(); e.stopPropagation();
      openInput();
    }
  }, true);

  inp.addEventListener('keydown', e => {
    e.stopPropagation(); // stop YouTube shortcuts (space, f, k...) while typing
    if (e.key === 'Enter') {
      const t = inp.value.trim();
      if (t) send({ t: 'chat', text: t });
      inp.value = '';   // box stays open for the next message
      bump();
    } else if (e.key === 'Escape') closeInput();
    else bump();
  });
  ['keyup', 'keypress'].forEach(ev => inp.addEventListener(ev, e => e.stopPropagation()));
  inp.addEventListener('input', bump);

  setInterval(() => send({ t: 'hb' }), 3000); // keeps the background connection alive

  chrome.runtime.sendMessage({ t: 'get' }).then(s => { if (s) { S = s; render(); } }).catch(() => {});
})();