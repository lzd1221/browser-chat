'use strict';
// 服务器端一次性清理脚本：删除指定测试账号及其消息
const fs = require('fs');
const p = '/opt/browser-chat/data/db.json';
const db = JSON.parse(fs.readFileSync(p, 'utf8'));
const ids = process.argv.slice(2);
if (!ids.length) { console.error('no ids'); process.exit(1); }
let removed = 0;
for (const id of ids) if (db.users[id]) { delete db.users[id]; removed++; }
for (const k of Object.keys(db.messages)) {
  const arr = db.messages[k];
  if (arr.length && (ids.includes(arr[0].from) || ids.includes(arr[0].to))) { delete db.messages[k]; removed++; }
}
fs.writeFileSync(p, JSON.stringify(db));
console.log('removed entries:', removed, '| remaining users:', Object.keys(db.users).length);
