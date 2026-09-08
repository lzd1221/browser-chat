'use strict';
/**
 * browser-chat —— 简洁浏览器聊天应用（单文件后端）
 * 功能：注册账号 / ID 登录 / 搜索 ID 加好友 / 实时聊天
 * 技术：Node.js 原生 HTTP + WebSocket(ws) + JSON 文件持久化，零构建
 *
 * 运行：PORT=3000 node server.js
 * 数据：./data/db.json（首次运行自动创建，已被 .gitignore 排除）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const ID_RE = /^[A-Za-z0-9_]{3,20}$/;        // ID 规则：字母/数字/下划线
const MAX_NICK = 20;                          // 昵称最大长度（可重名）
const MIN_PW = 4;
const MAX_TEXT = 2000;                        // 单条消息最大长度
const PAIR_KEEP = 500;                        // 每对好友保留的历史条数
const LOAD_LIMIT = 100;                       // 打开聊天时一次加载条数

/* ---------------- 数据存取 ---------------- */

let db = { users: {}, messages: {} };         // users: {id:{id,nickname,pass,createdAt,friends:[],requests:[{from,at}]}}
                                              // messages: {"a|b":[ {from,to,text,at,read} ]}  (a<b 字典序)
let dirty = false;
let saveTimer = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadDb() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    db = {
      users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
      messages: parsed.messages && typeof parsed.messages === 'object' ? parsed.messages : {},
    };
  } catch (e) {
    db = { users: {}, messages: {} };
  }
}
function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error('[save] 写入数据失败:', e.message);
    }
  }, 300);
}
function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!dirty) return;
  dirty = false;
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('[save] 写入数据失败:', e.message); }
}

/* ---------------- 密码 / 会话 ---------------- */

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  return salt + ':' + h;
}
function verifyPw(pw, stored) {
  try {
    const [s, h] = stored.split(':');
    const hh = crypto.scryptSync(pw, s, 64);
    const hb = Buffer.from(h, 'hex');
    return hh.length === hb.length && crypto.timingSafeEqual(hh, hb);
  } catch { return false; }
}

const sessions = new Map(); // token -> userId （内存会话，重启需重新登录）
function issueToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, userId);
  return token;
}
function bearerToken(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(\S+)$/.exec(h);
  return m ? m[1] : null;
}
function authUser(req) {
  const t = bearerToken(req);
  if (!t) return null;
  const id = sessions.get(t);
  return id && db.users[id] ? db.users[id] : null;
}

/* ---------------- 工具 ---------------- */

function pairKey(a, b) { return [a, b].sort().join('|'); }
function publicUser(u) { return { id: u.id, nickname: u.nickname, createdAt: u.createdAt }; }
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 1024 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
    catch { cb(null); }
  });
  req.on('error', () => cb(null));
}

/* ---------------- WebSocket（实时推送） ---------------- */

const wsUsers = new Map(); // userId -> Set<ws>
const wss = new WebSocketServer({ noServer: true });

function onlineIds() {
  const set = new Set();
  for (const [id, sockets] of wsUsers) if (sockets.size > 0) set.add(id);
  return set;
}
function wsSend(userId, obj) {
  const sockets = wsUsers.get(userId);
  if (!sockets) return;
  const data = JSON.stringify(obj);
  for (const ws of sockets) {
    if (ws.readyState === 1) { try { ws.send(data); } catch {} }
  }
}
function notifyPresence(userId, online) {
  const u = db.users[userId];
  if (!u) return;
  for (const fid of u.friends || []) wsSend(fid, { type: 'presence', id: userId, online });
}
function wsInitPresence(userId) {
  const u = db.users[userId];
  const list = [];
  if (u) for (const fid of u.friends || []) if (wsUsers.has(fid)) list.push(fid);
  wsSend(userId, { type: 'init', online: list });
}

function attachWs(ws, userId) {
  let set = wsUsers.get(userId);
  if (!set) { set = new Set(); wsUsers.set(userId, set); }
  const wasOffline = set.size === 0;
  set.add(ws);
  if (wasOffline) notifyPresence(userId, true);
  wsInitPresence(userId);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg && msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch {}
  });
  ws.on('close', () => {
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) { wsUsers.delete(userId); notifyPresence(userId, false); }
  });
  ws.on('error', () => {});
}

// 心跳保活：30s 内无 pong 则断开
const HB_INTERVAL = 30000;
function heartbeat() {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}
setInterval(heartbeat, HB_INTERVAL).unref();
wss.on('connection', (ws, req, userId) => { ws.isAlive = true; attachWs(ws, userId); });
wss.on('close', () => {});
// ws 内建连接也走同一逻辑

/* ---------------- 业务逻辑 ---------------- */

function friendReqState(me, otherId) {
  return { isFriend: (me.friends || []).includes(otherId), pending: (me.requests || []).some(r => r.from === otherId) };
}

function contactsOf(me) {
  const online = onlineIds();
  const friends = [];
  for (const fid of me.friends || []) {
    const fu = db.users[fid];
    if (!fu) continue;
    const pk = pairKey(me.id, fid);
    const arr = db.messages[pk] || [];
    let unread = 0, last = null;
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i];
      if (m.from === fid && !m.read) unread++;
      if (!last) last = m;
    }
    friends.push({
      ...publicUser(fu),
      online: online.has(fid),
      unread,
      lastText: last ? last.text : '',
      lastAt: last ? last.at : 0,
    });
  }
  friends.sort((a, b) => (b.lastAt || b.createdAt || 0) - (a.lastAt || a.createdAt || 0));
  const requests = (me.requests || [])
    .map(r => { const u = db.users[r.from]; return u ? { from: publicUser(u), at: r.at } : null; })
    .filter(Boolean);
  return { friends, requests };
}

function appendMessage(fromId, toId, text) {
  const pk = pairKey(fromId, toId);
  if (!db.messages[pk]) db.messages[pk] = [];
  const msg = { from: fromId, to: toId, text, at: Date.now(), read: false };
  db.messages[pk].push(msg);
  if (db.messages[pk].length > PAIR_KEEP) db.messages[pk].splice(0, db.messages[pk].length - PAIR_KEEP);
  scheduleSave();
  return msg;
}
function markRead(meId, otherId) {
  const pk = pairKey(meId, otherId);
  const arr = db.messages[pk] || [];
  let changed = false, upToAt = 0;
  for (const m of arr) if (m.to === meId && !m.read) { m.read = true; changed = true; if (m.at > upToAt) upToAt = m.at; }
  if (changed) {
    scheduleSave();
    // 实时通知对方：你的消息已被我读到（<= upToAt 的全部视为已读）
    wsSend(otherId, { type: 'read', by: meId, upToAt });
  }
  return changed;
}

/* ---------------- HTTP API ---------------- */

function api(req, res, pathname) {
  const method = req.method;

  /* 注册：id 唯一，昵称可重名 */
  if (pathname === '/api/register' && method === 'POST') {
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: '请求体无效' });
      const id = String(b.id || '').trim();
      const nickname = String(b.nickname || '').trim();
      const password = String(b.password || '');
      if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'ID 需为 3-20 位字母/数字/下划线' });
      if (!nickname || nickname.length > MAX_NICK) return sendJson(res, 400, { error: '昵称不能为空且不超过 20 字' });
      if (password.length < MIN_PW) return sendJson(res, 400, { error: '密码至少 4 位' });
      if (db.users[id]) return sendJson(res, 409, { error: '该 ID 已被注册，请换一个' });
      const u = { id, nickname, pass: hashPw(password), createdAt: Date.now(), friends: [], requests: [] };
      db.users[id] = u;
      scheduleSave();
      return sendJson(res, 200, { token: issueToken(id), user: publicUser(u) });
    });
  }

  /* 登录 */
  if (pathname === '/api/login' && method === 'POST') {
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: '请求体无效' });
      const id = String(b.id || '').trim();
      const password = String(b.password || '');
      const u = db.users[id];
      if (!u) return sendJson(res, 404, { error: '账号不存在' });
      if (!verifyPw(password, u.pass)) return sendJson(res, 401, { error: '密码错误' });
      return sendJson(res, 200, { token: issueToken(id), user: publicUser(u) });
    });
  }

  /* 以下接口需要登录 */
  const me = authUser(req);
  if (!me) return sendJson(res, 401, { error: '未登录或登录已过期' });

  /* 当前用户 */
  if (pathname === '/api/me' && method === 'GET') {
    return sendJson(res, 200, { user: publicUser(me), online: wsUsers.has(me.id) });
  }

  /* 搜索用户：按 ID 精确查找 */
  if (pathname === '/api/search' && method === 'GET') {
    const q = String((new URL(req.url, 'http://x').searchParams.get('q') || '')).trim();
    const found = q && db.users[q] ? db.users[q] : null;
    if (!found || found.id === me.id) return sendJson(res, 200, { user: null });
    return sendJson(res, 200, { user: publicUser(found), ...friendReqState(me, found.id) });
  }

  /* 联系人列表：好友（含未读/在线/最后消息）+ 收到的好友请求 */
  if (pathname === '/api/contacts' && method === 'GET') {
    return sendJson(res, 200, contactsOf(me));
  }

  /* 发送好友请求 */
  if (pathname === '/api/friends/request' && method === 'POST') {
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: '请求体无效' });
      const to = String(b.to || '').trim();
      if (!to || to === me.id) return sendJson(res, 400, { error: '不能添加自己' });
      const target = db.users[to];
      if (!target) return sendJson(res, 404, { error: '用户不存在' });
      if ((me.friends || []).includes(to)) return sendJson(res, 400, { error: '你们已经是好友了' });
      if ((target.requests || []).some(r => r.from === me.id)) return sendJson(res, 400, { error: '已发送过请求，请等待对方处理' });
      target.requests = target.requests || [];
      target.requests.push({ from: me.id, at: Date.now() });
      scheduleSave();
      wsSend(to, { type: 'req', from: publicUser(me) });
      return sendJson(res, 200, { ok: true });
    });
  }

  /* 处理好友请求（同意/拒绝） */
  if (pathname === '/api/friends/respond' && method === 'POST') {
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: '请求体无效' });
      const from = String(b.from || '').trim();
      const accept = !!b.accept;
      const reqs = me.requests || [];
      const idx = reqs.findIndex(r => r.from === from);
      if (idx < 0) return sendJson(res, 404, { error: '请求不存在或已处理' });
      me.requests.splice(idx, 1);
      const other = db.users[from];
      if (other) {
        if (accept) {
          me.friends = me.friends || []; other.friends = other.friends || [];
          if (!me.friends.includes(from)) me.friends.push(from);
          if (!other.friends.includes(me.id)) other.friends.push(me.id);
          wsSend(from, { type: 'accepted', by: publicUser(me) });
        }
      }
      scheduleSave();
      return sendJson(res, 200, { ok: true });
    });
  }

  /* 拉取与某好友的聊天记录（自动把对方发来的标记为已读） */
  if (pathname === '/api/messages' && method === 'GET') {
    const withId = String((new URL(req.url, 'http://x').searchParams.get('with') || '')).trim();
    if (!withId || !(me.friends || []).includes(withId)) return sendJson(res, 403, { error: '仅好友可聊天' });
    markRead(me.id, withId);
    const arr = db.messages[pairKey(me.id, withId)] || [];
    return sendJson(res, 200, { messages: arr.slice(-LOAD_LIMIT).map(m => ({ from: m.from, to: m.to, text: m.text, at: m.at, read: !!m.read })) });
  }

  /* 发送消息 */
  if (pathname === '/api/messages' && method === 'POST') {
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: '请求体无效' });
      const to = String(b.to || '').trim();
      const text = String(b.text || '').trim();
      if (!to || !(me.friends || []).includes(to)) return sendJson(res, 403, { error: '仅好友可聊天' });
      if (!text) return sendJson(res, 400, { error: '消息不能为空' });
      if (text.length > MAX_TEXT) return sendJson(res, 400, { error: '消息过长（最多 ' + MAX_TEXT + ' 字）' });
      const msg = appendMessage(me.id, to, text);
      wsSend(to, { type: 'msg', msg: { from: me.id, fromNick: me.nickname, text, at: msg.at } });
      return sendJson(res, 200, { msg: { from: msg.from, to: msg.to, text: msg.text, at: msg.at } });
    });
  }

  /* 标记已读 */
  if (pathname === '/api/read' && method === 'POST') {
    return readBody(req, (b) => {
      if (!b) return sendJson(res, 400, { error: '请求体无效' });
      const withId = String(b.with || '').trim();
      if (!withId) return sendJson(res, 400, { error: '参数缺失' });
      markRead(me.id, withId);
      return sendJson(res, 200, { ok: true });
    });
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

/* ---------------- 静态文件 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) {
    return sendJson(res, 404, { error: 'not found' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* ---------------- 启动 ---------------- */

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname.startsWith('/api/')) return api(req, res, pathname);
  return serveStatic(res, pathname);
});

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const token = url.searchParams.get('token') || '';
  const userId = sessions.get(token);
  if (!userId || !db.users[userId]) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, userId);
  });
});

loadDb();
server.listen(PORT, () => {
  console.log('browser-chat 已启动: http://0.0.0.0:' + PORT);
  console.log('数据文件: ' + DB_FILE);
});
server.on('error', (e) => { console.error('启动失败:', e.message); process.exit(1); });

process.on('SIGINT', () => { flushSave(); process.exit(0); });
process.on('SIGTERM', () => { flushSave(); process.exit(0); });
