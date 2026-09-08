'use strict';
// CDP 截图工具：登录后打开聊天、模拟输入长文本，截图桌面/手机两种视口
const fs = require('fs');
const CDP_PORT = process.env.CDP_PORT || 9223;
const APP = process.env.APP_URL || 'http://127.0.0.1:3210/';
const TOKEN = process.env.TOKEN_A || '';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getJson(u, opts) {
  const res = await fetch(u, opts);
  return res.json();
}

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function shot(page, cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(name, Buffer.from(r.data, 'base64'));
  console.log('saved ' + name);
}

(async () => {
  const target = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/new?' + encodeURIComponent(APP), { method: 'PUT' });
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await sleep(2500); // 首页(登录页)

  // 设置 token 并刷新进入主界面
  await cdp.send('Runtime.evaluate', { expression: "localStorage.setItem('bc_token', '" + TOKEN + "')" });
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(3200);

  // 桌面视口：主界面（好友列表）
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  await shot(page, cdp, 'test/shot-desktop-main.png');

  // 点开第一个好友聊天
  await cdp.send('Runtime.evaluate', { expression: "document.querySelector('.friend-item') && document.querySelector('.friend-item').click(); 'ok'" });
  await sleep(2500);
  await shot(page, cdp, 'test/shot-desktop-chat.png');

  // 模拟输入长文本（触发 input 事件走 autosize）
  await cdp.send('Runtime.evaluate', { expression: `
    (function(){
      const ta = document.querySelector('#msgInput');
      ta.value = '这是一段很长很长的消息内容用来模拟用户输入时候的换行效果，看看每个字是不是会单独占一行测试测试测试测试';
      ta.dispatchEvent(new Event('input'));
      return 'typed';
    })()` });
  await sleep(400);
  await shot(page, cdp, 'test/shot-desktop-typing.png');

  // 手机视口
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(3200);
  await shot(page, cdp, 'test/shot-phone-main.png');
  await cdp.send('Runtime.evaluate', { expression: "document.querySelector('.friend-item') && document.querySelector('.friend-item').click(); 'ok'" });
  await sleep(2500);
  await shot(page, cdp, 'test/shot-phone-chat.png');
  await cdp.send('Runtime.evaluate', { expression: `
    (function(){
      const ta = document.querySelector('#msgInput');
      ta.value = '这是一段很长很长的消息内容用来模拟手机输入时候的换行效果';
      ta.dispatchEvent(new Event('input'));
      return 'typed';
    })()` });
  await sleep(400);
  await shot(page, cdp, 'test/shot-phone-typing.png');

  cdp.close();
  process.exit(0);
})().catch(e => { console.error('CDP error:', e.message); process.exit(1); });
