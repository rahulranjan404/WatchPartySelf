const $ = id => document.getElementById(id);
let S = { room: null, me: null, members: [] };
const msg = m => chrome.runtime.sendMessage(m).catch(() => {});
const short = (u, n) => (u.length > n ? u.slice(0, n - 3) + '...' : u);

function saveName() { msg({ t: 'setname', name: $('name').value }); }

function render() {
  $('dot').className = 'sdot' + (S.connected ? ' ok' : '');
  $('stt').textContent = S.connected ? 'Connected' : 'Disconnected';
  $('page').textContent = S.url ? ' · ' + short(S.url.replace(/^https?:\/\//, ''), 26) : '';
  if (document.activeElement !== $('name')) $('name').value = S.name || '';

  $('home').style.display = S.room ? 'none' : 'block';
  $('room').style.display = S.room ? 'block' : 'none';
  if (!S.room) return;
  $('rid').textContent = S.room;

  const list = $('list');
  list.innerHTML = '';
  S.members.forEach(m => {
    const me = S.me && m.id === S.me.id;
    const row = document.createElement('div');
    row.className = 'member';

    const av = document.createElement('div');
    av.className = 'av' + (m.online ? '' : ' off');
    av.style.background = m.color;
    av.textContent = (m.name || '?').trim().charAt(0).toUpperCase();

    const box = document.createElement('div');
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.append(document.createTextNode(m.name || 'Guest'));
    if (m.host) nm.append(Object.assign(document.createElement('span'), { className: 'tag host', textContent: 'HOST' }));
    if (me) nm.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: 'YOU' }));
    box.appendChild(nm);

    if (m.url) {
      const a = document.createElement('a');
      a.textContent = short(m.url.replace(/^https?:\/\//, ''), 44);
      a.title = m.url;
      if (!me) a.onclick = () => chrome.tabs.update({ url: m.url }); // jump to their page
      else a.style.pointerEvents = 'none';
      box.appendChild(a);
    } else {
      box.appendChild(Object.assign(document.createElement('div'), { className: 'sub', textContent: 'not on Chrome' }));
    }
    row.append(av, box);
    list.appendChild(row);
  });
}

$('create').onclick = () => { $('err').textContent = ''; saveName(); msg({ t: 'create' }); };
$('join').onclick = () => {
  $('err').textContent = '';
  if ($('code').value.trim()) { saveName(); msg({ t: 'join', room: $('code').value }); }
};
$('leave').onclick = () => msg({ t: 'leave' });
$('start').onclick = () => msg({ t: 'startover' });
$('copy').onclick = () => {
  navigator.clipboard.writeText(S.room);
  $('copy').textContent = 'Copied!';
  setTimeout(() => ($('copy').textContent = 'Copy'), 1200);
};
$('save').onclick = () => { saveName(); $('save').textContent = 'Saved ✓'; setTimeout(() => ($('save').textContent = 'Save'), 1200); };
$('name').addEventListener('keydown', e => { if (e.key === 'Enter') $('save').click(); });
$('name').addEventListener('change', saveName);

chrome.runtime.onMessage.addListener(m => {
  if (m.t === 'S') { S = m.S; render(); }
  if (m.t === 'error') $('err').textContent = m.msg;
});
msg({ t: 'get' }).then(s => { if (s) { S = s; render(); } });