'use strict';
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const js = fs.readFileSync('public/app.js', 'utf8');
const ids = [...js.matchAll(/\$\('#([A-Za-z0-9_]+)'\)/g)].map(m => m[1]);
const uniq = [...new Set(ids)];
const missing = uniq.filter(id => !html.includes('id="' + id + '"'));
console.log('选择器引用的 id 数:', uniq.length);
console.log(missing.length ? ('缺失: ' + missing.join(',')) : '全部存在于 HTML ✔');
