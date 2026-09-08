'use strict';
// 线上已读功能实测：随机 ID 注册→加好友→发消息→读取→验证 read 回执；结束后把 ID 打到 stdout 供清理
const BASE = process.env.TEST_BASE || 'http://150.109.50.157:8092';
const WSURL = process.env.TEST_WS || 'ws://150.109.50.157:8092';
const suffix = String(Date.now()).slice(-8);
const idA = 'chkA' + suffix, idB = 'chkB' + suffix;

async function api(path, opts = {}, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { ...opts, headers });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const post = (p, body, t) => api(p, { method: 'POST', body: JSON.stringify(body) }, t);
const waitWs = (ws, type, timeout = 6000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('等待 ' + type + ' 超时')), timeout);
  function on(raw) { let m; try { m = JSON.parse(raw.toString()); } catch { return; } if (m.type === type) { clearTimeout(timer); ws.off('message', on); resolve(m); } }
  ws.on('message', on);
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? '  ✔ ' : '  ✘ ') + n + (x && !c ? ' -> ' + JSON.stringify(x) : '')); };

(async () => {
  console.log('live read-check ids: ' + idA + ' / ' + idB);
  const a = await post('/api/register', { id: idA, nickname: '检查员A', password: '1234' });
  const b = await post('/api/register', { id: idB, nickname: '检查员B', password: '1234' });
  const ta = a.data && a.data.token, tb = b.data && b.data.token;
  ok('注册两个临时账号', !!ta && !!tb, { a: a.status, b: b.status });
  if (!ta || !tb) { console.log('CLEANUP_IDS=' + idA + ',' + idB); process.exit(fail ? 1 : 0); }
  await post('/api/friends/request', { to: idB }, ta);
  await post('/api/friends/respond', { from: idA, accept: true }, tb);

  const wsB = new (require('ws'))(WSURL + '/ws?token=' + tb);
  await new Promise((res, rej) => { wsB.on('open', res); wsB.on('error', rej); });
  const wsA = new (require('ws'))(WSURL + '/ws?token=' + ta);
  await new Promise((res, rej) => { wsA.on('open', res); wsA.on('error', rej); });

  const pMsg = waitWs(wsB, 'msg');
  const send = await post('/api/messages', { to: idB, text: '已读功能线上验证消息' }, ta);
  ok('A 发消息成功', send.status === 200, send);
  await pMsg;

  let msgs = (await api('/api/messages?with=' + idB, {}, ta)).data.messages;
  const m = msgs.find(x => x.text === '已读功能线上验证消息');
  ok('B 未读时 A 侧 read=false', m && m.read === false, m);

  const pRead = waitWs(wsA, 'read');
  await api('/api/messages?with=' + idA, {}, tb);
  const ev = await pRead;
  ok('B 读取后 A 实时收到 read 回执', ev && ev.by === idB && ev.upToAt >= m.at, ev);

  msgs = (await api('/api/messages?with=' + idB, {}, ta)).data.messages;
  const m2 = msgs.find(x => x.text === '已读功能线上验证消息');
  ok('B 已读后 A 侧 read=true', m2 && m2.read === true, m2);

  wsA.close(); wsB.close();
  console.log('CLEANUP_IDS=' + idA + ',' + idB);
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); process.exit(1); });
