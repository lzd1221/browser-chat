'use strict';
/* browser-chat 前端逻辑 */

const $ = (sel) => document.querySelector(sel);

const state = {
  token: localStorage.getItem('bc_token') || '',
  me: null,
  contacts: { friends: [], requests: [] },
  activeId: null,
  ws: null,
  wsRetry: 0,
  avatars: {}, // id -> color
};

const AVATAR_COLORS = ['#2f6fed', '#0ea5a4', '#8b5cf6', '#e4567a', '#f59e0b', '#10b981', '#e2442c', '#0f9be8', '#a96c2e', '#ec4899'];
function avatarColor(id) {
  if (!state.avatars[id]) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    state.avatars[id] = AVATAR_COLORS[h % AVATAR_COLORS.length];
  }
  return state.avatars[id];
}
function avatarEl(id, nickname, cls) {
  const el = document.createElement('span');
  el.className = 'avatar' + (cls ? ' ' + cls : '');
  el.style.background = avatarColor(id);
  el.textContent = (nickname || id || '?').slice(0, 1).toUpperCase();
  return el;
}
function setAvatar(el, id, nickname) {
  el.style.background = avatarColor(id);
  el.textContent = (nickname || id || '?').slice(0, 1).toUpperCase();
}
function esc(s) { return String(s == null ? '' : s); }
function fmtTime(at) {
  const d = new Date(at);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return hm;
  return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + hm;
}

/* ---------- HTTP ---------- */
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const res = await fetch(path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || ('请求失败 (' + res.status + ')'));
  return data;
}
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ---------- 登录 / 注册 ---------- */
function showAuth() {
  $('#appView').classList.add('hidden');
  $('#authView').classList.remove('hidden');
  syncView();
}
function showApp() {
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  syncView();
}

/* 窄屏(<=720px)下：好友列表与聊天面板全屏切换，body.chat-open 时只显示聊天 */
function syncView() {
  const narrow = window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
  document.body.classList.toggle('chat-open', !!(narrow && state.activeId));
}

function setAuthError(msg) { $('#authError').textContent = msg || ''; }

function switchTab(reg) {
  $('#tabLogin').classList.toggle('active', !reg);
  $('#tabRegister').classList.toggle('active', reg);
  $('#formLogin').classList.toggle('hidden', reg);
  $('#formRegister').classList.toggle('hidden', !reg);
  setAuthError('');
}

$('#tabLogin').onclick = () => switchTab(false);
$('#tabRegister').onclick = () => switchTab(true);

$('#formLogin').onsubmit = async (e) => {
  e.preventDefault();
  setAuthError('');
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ id: $('#loginId').value.trim(), password: $('#loginPw').value }),
    });
    enter(data.token, data.user);
  } catch (err) { setAuthError(err.message); }
};

$('#formRegister').onsubmit = async (e) => {
  e.preventDefault();
  setAuthError('');
  const pw = $('#regPw').value, pw2 = $('#regPw2').value;
  if (pw !== pw2) { setAuthError('两次输入的密码不一致'); return; }
  try {
    const data = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ id: $('#regId').value.trim(), nickname: $('#regNick').value.trim(), password: pw }),
    });
    enter(data.token, data.user);
  } catch (err) { setAuthError(err.message); }
};

$('#btnLogout').onclick = () => {
  state.token = '';
  localStorage.removeItem('bc_token');
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  state.me = null;
  state.activeId = null;
  showAuth();
};

function enter(token, user) {
  state.token = token;
  state.me = user;
  localStorage.setItem('bc_token', token);
  $('#meNick').textContent = user.nickname;
  $('#meId').textContent = 'ID: ' + user.id;
  setAvatar($('#meAvatar'), user.id, user.nickname);
  showApp();
  connectWs();
  loadContacts();
}

/* ---------- WebSocket ---------- */
function connectWs() {
  if (!state.me) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/ws?token=' + encodeURIComponent(state.token));
  state.ws = ws;

  ws.onopen = () => { state.wsRetry = 0; };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleWs(msg);
  };
  ws.onclose = () => {
    if (!state.me) return;
    state.wsRetry++;
    setTimeout(() => { if (state.me && (!state.ws || state.ws.readyState > 1)) connectWs(); }, Math.min(500 * state.wsRetry, 5000));
  };
  ws.onerror = () => {};
}

function handleWs(msg) {
  if (msg.type === 'init') {
    const onlineSet = new Set(msg.online || []);
    state.contacts.friends.forEach(f => { f.online = onlineSet.has(f.id); });
    renderFriends();
    updateChatHeader();
  } else if (msg.type === 'presence') {
    const f = state.contacts.friends.find(x => x.id === msg.id);
    if (f) { f.online = msg.online; renderFriends(); updateChatHeader(); }
  } else if (msg.type === 'req') {
    toast('收到 ' + (msg.from.nickname || msg.from.id) + ' 的好友请求');
    loadContacts();
  } else if (msg.type === 'accepted') {
    toast((msg.by.nickname || msg.by.id) + ' 已同意你的好友请求');
    loadContacts();
  } else if (msg.type === 'msg') {
    loadContacts();
    if (state.activeId === msg.msg.from) {
      // 正在与该好友聊天：拉取最新（服务端顺带标记已读）
      openChat(state.activeId, true);
    }
  }
}

/* ---------- 联系人 / 好友 ---------- */
async function loadContacts() {
  try {
    const data = await api('/api/contacts');
    state.contacts = data;
    renderRequests();
    renderFriends();
    updateChatHeader();
  } catch (err) {
    if (/401|登录/.test(err.message)) { forceLogout(); }
  }
}

function renderRequests() {
  const list = state.contacts.requests || [];
  const sec = $('#reqSection');
  if (!list.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  const count = $('#reqCount');
  count.textContent = list.length;
  count.classList.remove('hidden');
  const box = $('#reqList');
  box.replaceChildren();
  list.forEach(r => {
    const item = document.createElement('div');
    item.className = 'req-item';
    item.append(avatarEl(r.from.id, r.from.nickname, 'avatar-sm'));
    const info = document.createElement('div');
    info.className = 'req-info';
    const b = document.createElement('b'); b.textContent = r.from.nickname;
    const s = document.createElement('div'); s.className = 'side-id'; s.textContent = 'ID: ' + r.from.id;
    info.append(b, s);
    const btns = document.createElement('div');
    btns.className = 'req-btns';
    const ok = document.createElement('button');
    ok.className = 'btn-mini btn-accept'; ok.textContent = '同意';
    ok.onclick = () => respond(r.from.id, true);
    const no = document.createElement('button');
    no.className = 'btn-mini btn-decline'; no.textContent = '拒绝';
    no.onclick = () => respond(r.from.id, false);
    btns.append(ok, no);
    item.append(avatarEl(r.from.id, r.from.nickname, 'avatar-sm'), info, btns);
    box.append(item);
  });
}

async function respond(from, accept) {
  try {
    await api('/api/friends/respond', { method: 'POST', body: JSON.stringify({ from, accept }) });
    if (accept) toast('已添加 ' + from + ' 为好友');
    loadContacts();
  } catch (err) { toast(err.message); }
}

function friendEl(f) {
  const item = document.createElement('div');
  item.className = 'friend-item' + (f.id === state.activeId ? ' active' : '');
  item.append(avatarEl(f.id, f.nickname));
  const main = document.createElement('div');
  main.className = 'f-main';
  const l1 = document.createElement('div');
  l1.className = 'f-line1';
  const nick = document.createElement('span');
  nick.className = 'f-nick';
  const dot = document.createElement('span');
  dot.className = 'dot ' + (f.online ? 'on' : 'off');
  dot.title = f.online ? '在线' : '离线';
  nick.append(dot, document.createTextNode(f.nickname));
  const time = document.createElement('span');
  time.className = 'f-time';
  time.textContent = f.lastAt ? fmtTime(f.lastAt) : '';
  l1.append(nick, time);
  const l2 = document.createElement('div');
  l2.className = 'f-line2';
  const prev = document.createElement('span');
  prev.className = 'f-preview';
  prev.textContent = f.lastText || '开始聊天吧';
  l2.append(prev);
  if (f.unread > 0) {
    const u = document.createElement('span');
    u.className = 'f-unread';
    u.textContent = f.unread > 99 ? '99+' : f.unread;
    l2.append(u);
  }
  main.append(l1, l2);
  item.append(main);
  item.onclick = () => openChat(f.id);
  return item;
}

function renderFriends() {
  const list = $('#friendList');
  const friends = state.contacts.friends || [];
  list.replaceChildren(...friends.map(friendEl));
  $('#emptyHint').classList.toggle('hidden', friends.length > 0);
}

/* ---------- 聊天 ---------- */
async function openChat(id, keepScroll) {
  state.activeId = id;
  const f = (state.contacts.friends || []).find(x => x.id === id);
  if (!f) return;
  renderFriends();
  $('#chatEmpty').classList.add('hidden');
  $('#chatPanel').classList.remove('hidden');
  $('#chatNick').textContent = f.nickname;
  $('#chatId').textContent = 'ID: ' + f.id;
  setAvatar($('#chatAvatar'), f.id, f.nickname);
  updateChatHeader();
  syncView();

  let data;
  try { data = await api('/api/messages?with=' + encodeURIComponent(id)); }
  catch (err) { toast(err.message); return; }
  renderMessages(data.messages || [], f);
  if (!keepScroll) scrollToBottom(true);
  // 清空未读标记并刷新列表
  state.contacts.friends.forEach(x => { if (x.id === id) x.unread = 0; });
  renderFriends();
  await api('/api/read', { method: 'POST', body: JSON.stringify({ with: id }) }).catch(() => {});
  $('#msgInput').focus();
}

function updateChatHeader() {
  if (!state.activeId) return;
  const f = (state.contacts.friends || []).find(x => x.id === state.activeId);
  const tag = $('#chatOnline');
  if (!f) { $('#chatPanel').classList.add('hidden'); $('#chatEmpty').classList.remove('hidden'); return; }
  tag.textContent = f.online ? '● 在线' : '离线';
  tag.className = 'online-tag' + (f.online ? '' : ' offline');
}

function renderMessages(messages, f) {
  const box = $('#msgList');
  const frag = document.createDocumentFragment();

  // 把消息切成"同方向连续段"，每段最后一条带头像/时间
  const runs = [];
  for (const m of messages) {
    const mine = m.from === state.me.id;
    const last = runs[runs.length - 1];
    if (last && last.mine === mine && (m.at - last.at) < 5 * 60 * 1000) last.msgs.push(m);
    else runs.push({ mine, msgs: [m], at: m.at });
  }
  runs.forEach(run => {
    run.msgs.forEach((m, i) => {
      const isLast = i === run.msgs.length - 1;
      const row = document.createElement('div');
      row.className = 'msg-row ' + (run.mine ? 'mine' : 'friend');
      if (!run.mine && isLast) row.append(avatarEl(m.from, f.nickname));
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      const bub = document.createElement('div');
      bub.className = 'msg-bubble';
      bub.textContent = m.text;
      meta.append(bub);
      if (isLast) {
        const t = document.createElement('div');
        t.className = 'msg-time';
        t.textContent = fmtTime(m.at);
        meta.append(t);
      }
      row.append(meta);
      frag.append(row);
    });
  });
  box.replaceChildren(frag);
}

function scrollToBottom(force) {
  const box = $('#msgList');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

async function sendMessage() {
  const input = $('#msgInput');
  const text = input.value.trim();
  if (!text || !state.activeId) return;
  try {
    const data = await api('/api/messages', { method: 'POST', body: JSON.stringify({ to: state.activeId, text }) });
    input.value = '';
    autosize();
    const f = (state.contacts.friends || []).find(x => x.id === state.activeId);
    const box = $('#msgList');
    // 追加自己的气泡
    const row = document.createElement('div');
    row.className = 'msg-row mine';
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const bub = document.createElement('div');
    bub.className = 'msg-bubble';
    bub.textContent = text;
    const t = document.createElement('div');
    t.className = 'msg-time';
    t.textContent = fmtTime(data.msg.at);
    meta.append(bub, t);
    row.append(meta);
    box.append(row);
    scrollToBottom(true);
    if (f) { f.lastText = text; f.lastAt = data.msg.at; }
    renderFriends();
  } catch (err) { toast(err.message); }
}

function autosize() {
  const ta = $('#msgInput');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

$('#btnSend').onclick = sendMessage;
$('#btnBack').onclick = () => {
  state.activeId = null;
  renderFriends();
  syncView();
};
$('#msgInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$('#msgInput').addEventListener('input', autosize);

/* ---------- 搜索加好友 ---------- */
let searchTimer = null;
$('#searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('#searchInput').value.trim();
  if (!q) return;
  searchTimer = setTimeout(() => doSearch(q), 300);
});
$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); doSearch($('#searchInput').value.trim()); }
});

async function doSearch(q) {
  if (!q) return;
  const box = $('#searchResult');
  box.replaceChildren();
  const p = document.createElement('p');
  p.className = 'muted';
  if (!/^[A-Za-z0-9_]{1,20}$/.test(q)) { p.textContent = 'ID 只能包含字母、数字、下划线'; box.append(p); showSearchModal(); return; }
  p.textContent = '搜索中…';
  box.append(p);
  showSearchModal();
  let data;
  try { data = await api('/api/search?q=' + encodeURIComponent(q)); }
  catch (err) { box.replaceChildren(); const pe = document.createElement('p'); pe.className = 'muted'; pe.textContent = err.message; box.append(pe); return; }
  box.replaceChildren();
  if (!data.user) {
    const pn = document.createElement('p');
    pn.textContent = '未找到 ID 为「' + q + '」的用户';
    box.append(pn);
    return;
  }
  // 展示用户卡片
  const uRow = document.createElement('div');
  uRow.className = 'search-user';
  uRow.append(avatarEl(data.user.id, data.user.nickname, 'avatar-lg'));
  const meta = document.createElement('div');
  meta.className = 'su-meta';
  const b = document.createElement('b'); b.textContent = data.user.nickname;
  const s = document.createElement('span'); s.textContent = 'ID: ' + data.user.id;
  meta.append(b, s);
  uRow.append(meta);
  box.append(uRow);

  let btn;
  if (data.isFriend) {
    const tip = document.createElement('span');
    tip.className = 'muted'; tip.textContent = '你们已经是好友';
    box.append(tip);
  } else if (data.pending) {
    const tip = document.createElement('span');
    tip.className = 'muted'; tip.textContent = '已发送请求，等待对方同意';
    box.append(tip);
  } else {
    btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.textContent = '发送好友请求';
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api('/api/friends/request', { method: 'POST', body: JSON.stringify({ to: data.user.id }) });
        toast('好友请求已发送');
        btn.replaceWith(Object.assign(document.createElement('span'), { className: 'muted', textContent: '已发送请求，等待对方同意' }));
        closeSearchModal();
      } catch (err) {
        btn.disabled = false;
        toast(err.message);
      }
    };
    box.append(btn);
  }
}

function showSearchModal() { $('#searchModal').classList.remove('hidden'); }
function closeSearchModal() { $('#searchModal').classList.add('hidden'); }
$('#btnCloseModal').onclick = closeSearchModal;
$('#searchModal').addEventListener('click', (e) => { if (e.target === $('#searchModal')) closeSearchModal(); });

/* ---------- 启动 ---------- */
function forceLogout() {
  toast('登录已过期，请重新登录');
  state.token = '';
  localStorage.removeItem('bc_token');
  state.me = null;
  state.activeId = null;
  showAuth();
}

// 窗口在窄/宽屏间切换时刷新布局模式
(function watchViewport() {
  if (!window.matchMedia) return;
  const mq = window.matchMedia('(max-width: 720px)');
  const fn = () => syncView();
  if (mq.addEventListener) mq.addEventListener('change', fn);
  else if (mq.addListener) mq.addListener(fn);
})();

(async function init() {
  if (!state.token) { showAuth(); return; }
  try {
    const data = await api('/api/me');
    enter(data.token ? data.token : state.token, data.user);
  } catch {
    forceLogout();
  }
})();
