'use strict';
// 线上备注功能实测：随机 ID → 好友 → 设置/读取/清除备注；打印 CLEANUP_IDS
const BASE = process.env.TEST_BASE || 'http://150.109.50.157:8092';
const suffix = String(Date.now()).slice(-8);
const idA = 'rmkA' + suffix, idB = 'rmkB' + suffix;
async function api(path, opts = {}, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { ...opts, headers });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const post = (p, body, t) => api(p, { method: 'POST', body: JSON.stringify(body) }, t);
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? '  ✔ ' : '  ✘ ') + n + (x && !c ? ' -> ' + JSON.stringify(x) : '')); };

(async () => {
  console.log('live remark-check ids: ' + idA + ' / ' + idB);
  const a = await post('/api/register', { id: idA, nickname: '备注员甲', password: '1234' });
  const b = await post('/api/register', { id: idB, nickname: '备注员乙', password: '1234' });
  const ta = a.data && a.data.token;
  ok('注册临时账号', !!ta && b.status === 200, { a: a.status, b: b.status });
  if (!ta) { console.log('CLEANUP_IDS=' + idA + ',' + idB); process.exit(fail ? 1 : 0); }
  await post('/api/friends/request', { to: idB }, ta);
  await post('/api/friends/respond', { from: idA, accept: true }, (b.data || {}).token);

  let r = await post('/api/friends/remark', { to: idB, remark: '楼下卖早餐的大姐' }, ta);
  ok('设置备注成功', r.status === 200 && r.data.remark === '楼下卖早餐的大姐', r);
  r = await api('/api/contacts', {}, ta);
  ok('联系人接口返回备注', (r.data.friends.find(f => f.id === idB) || {}).remark === '楼下卖早餐的大姐', r.data);
  r = await post('/api/friends/remark', { to: idB, remark: '' }, ta);
  ok('清空备注成功', r.status === 200, r);
  r = await api('/api/contacts', {}, ta);
  ok('备注已清除', (r.data.friends.find(f => f.id === idB) || {}).remark === '', r.data);

  console.log('CLEANUP_IDS=' + idA + ',' + idB);
  console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); process.exit(1); });
