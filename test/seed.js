'use strict';
// 造测试数据：注册 u1/u2 → 互为好友 → u2 发一条长消息给 u1；输出 token
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3210';
async function api(path, opts = {}, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { ...opts, headers });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const post = (p, body, t) => api(p, { method: 'POST', body: JSON.stringify(body) }, t);

(async () => {
  const a = await post('/api/register', { id: 'alice01', nickname: '爱丽丝', password: '1234' });
  const b = await post('/api/register', { id: 'bob002', nickname: '博博', password: '1234' });
  const ta = a.data.token, tb = b.data.token;
  await post('/api/friends/request', { to: 'bob002' }, ta);
  await post('/api/friends/respond', { from: 'alice01', accept: true }, tb);
  const longText = '这是一条比较长的测试消息，用来检查聊天气泡和输入框的换行显示是否正常，测试测试测试测试测试。';
  for (let i = 0; i < 3; i++) {
    await post('/api/messages', { to: 'alice01', text: longText + ' [' + i + ']' }, tb);
  }
  await post('/api/messages', { to: 'bob002', text: '收到啦，这样回复看看效果。' }, ta);
  console.log('TOKEN_A=' + ta);
  console.log('TOKEN_B=' + tb);
})().catch(e => { console.error('seed failed', e); process.exit(1); });
