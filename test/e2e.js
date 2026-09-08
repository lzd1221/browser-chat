'use strict';
/* browser-chat 端到端冒烟测试：需要先启动服务 PORT=3210 node server.js */
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3210';
const WS = process.env.TEST_WS || 'ws://127.0.0.1:3210';

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✔ ' + name); }
  else { failed++; console.log('  ✘ ' + name + (extra ? '  -> ' + JSON.stringify(extra) : '')); }
}

async function api(path, opts = {}, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const post = (p, body, token) => api(p, { method: 'POST', body: JSON.stringify(body) }, token);

function waitWsMsg(ws, type, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', on); reject(new Error('等待 ' + type + ' 超时')); }, timeout);
    function on(raw) {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === type) { clearTimeout(timer); ws.off('message', on); resolve(m); }
    }
    ws.on('message', on);
  });
}

(async () => {
  console.log('== 1. 注册/登录/唯一性 ==');
  let r = await post('/api/register', { id: 'aaa001', nickname: '小明', password: '1234' });
  ok('注册 A 成功', r.status === 200 && r.data.token && r.data.user.id === 'aaa001', r);
  const ta = r.data.token;
  r = await post('/api/register', { id: 'bbb002', nickname: '小红', password: 'abcd' });
  ok('注册 B 成功', r.status === 200, r);
  const tb = r.data.token;
  r = await post('/api/register', { id: 'aaa001', nickname: '别人', password: 'xxxx' });
  ok('重复 ID 被拒绝(409)', r.status === 409, r);
  r = await post('/api/register', { id: 'ccc003', nickname: '小明', password: 'abcd' });
  ok('昵称可重名：第三个用户也叫"小明"成功', r.status === 200, r);
  const tc = r.data.token;
  r = await post('/api/login', { id: 'aaa001', password: 'wrong' });
  ok('错误密码拒绝(401)', r.status === 401, r);
  r = await api('/api/me', {}, ta);
  ok('A 获取个人信息', r.status === 200 && r.data.user.nickname === '小明', r);

  console.log('== 2. 搜索 / 好友请求 / 同意 ==');
  r = await api('/api/search?q=bbb002', {}, ta);
  ok('A 搜索到 B', r.data.user && r.data.user.id === 'bbb002' && r.data.isFriend === false, r.data);
  r = await api('/api/search?q=nobody', {}, ta);
  ok('搜索不存在的 ID 返回 user:null', r.data.user === null, r.data);
  r = await api('/api/search?q=aaa001', {}, ta);
  ok('搜索自己返回 user:null', r.data.user === null, r.data);
  r = await post('/api/friends/request', { to: 'bbb002' }, ta);
  ok('A 向 B 发好友请求', r.status === 200, r);
  r = await post('/api/friends/request', { to: 'bbb002' }, ta);
  ok('重复请求被拒绝(400)', r.status === 400, r);
  r = await api('/api/contacts', {}, tb);
  ok('B 的联系人里看到请求', r.data.requests.length === 1 && r.data.requests[0].from.id === 'aaa001', r.data);
  r = await post('/api/friends/respond', { from: 'aaa001', accept: true }, tb);
  ok('B 同意请求', r.status === 200, r);
  r = await api('/api/contacts', {}, ta);
  ok('A 的好友列表包含 B', r.data.friends.some(f => f.id === 'bbb002'), r.data.friends);
  r = await api('/api/contacts', {}, tb);
  ok('B 的好友列表包含 A', r.data.friends.some(f => f.id === 'aaa001'), r.data.friends);

  console.log('== 3. 聊天（REST + WebSocket 实时） ==');
  const wsA = new (require('ws'))(WS + '/ws?token=' + ta);
  await new Promise((res, rej) => { wsA.on('open', res); wsA.on('error', rej); });
  const pMsg = waitWsMsg(wsA, 'msg');
  r = await post('/api/messages', { to: 'aaa001', text: '你好，小红！' }, tb);
  ok('B 给 A 发消息成功', r.status === 200, r);
  const ev = await pMsg;
  ok('A 通过 WS 实时收到消息', ev.msg && ev.msg.text === '你好，小红！' && ev.msg.from === 'bbb002', ev);
  r = await api('/api/messages?with=bbb002', {}, ta);
  ok('A 拉到聊天记录且包含 B 的消息', r.data.messages.some(m => m.text === '你好，小红！'), r.data);
  r = await api('/api/contacts', {}, tc);
  ok('C 与 A/B 无关系，无好友请求', r.data.requests.length === 0 && r.data.friends.length === 0, r.data);
  r = await post('/api/messages', { to: 'ccc003', text: 'hi' }, ta);
  ok('非好友发消息被拒(403)', r.status === 403, r);

  console.log('== 4. 非法/边界 ==');
  r = await api('/api/search?q=abc', {}, 'bad-token');
  ok('无效 token 访问被拒(401)', r.status === 401, r);

  const badWs = new (require('ws'))(WS + '/ws?token=bad');
  await new Promise((res) => {
    badWs.on('error', res); badWs.on('close', (c) => res(c));
  });
  ok('无效 token 连接 WS 被拒绝', true);

  wsA.close();
  console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
