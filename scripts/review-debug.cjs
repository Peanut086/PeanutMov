/** 评审调试脚本：定位媒体库闪烁/分类筛选/进度写回/继续观看问题 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE = process.env.BASE_URL || 'http://localhost:5175';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9445;
const PROFILE = path.join(os.tmpdir(), `peanutmov-dbg-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }
      }, 40000);
    });
  }
  on(m, fn) {
    if (!this.listeners.has(m)) this.listeners.set(m, []);
    this.listeners.get(m).push(fn);
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.exceptionDetails) throw new Error(`eval: ${res.exceptionDetails.text} :: ${expression.slice(0, 160)}`);
    return res.result.value;
  }
}

async function main() {
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
  const logs = [];
  try {
    for (let i = 0; i < 80; i++) {
      try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(200); }
    }
    const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const t = list.find((x) => x.id === targetId);
    const pws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => pws.addEventListener('open', r, { once: true }));
    const page = new Cdp(pws);
    page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') logs.push((p.args ?? []).map(a => a.value ?? a.description).join(' ')); });
    page.on('Runtime.exceptionThrown', (p) => logs.push('EXC ' + (p.exceptionDetails?.exception?.description ?? '')));
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

    await page.send('Page.navigate', { url: `${BASE}/#/welcome` });
    await sleep(2500);
    await page.eval(`(() => { const b = [...document.querySelectorAll('button')].find(n => /我已阅读并同意/.test(n.textContent||'')); b && b.click(); return true; })()`);
    await sleep(4000);

    // 媒体库：采样卡片数随时间变化
    await page.eval(`location.hash = '#/library'`);
    const samples = [];
    for (let i = 0; i < 24; i++) {
      samples.push(await page.eval(`(() => ({
        t: ${i * 250},
        cards: document.querySelectorAll('.poster-card').length,
        skeleton: document.querySelectorAll('.skeleton').length,
        tabs: [...document.querySelectorAll('[role="tab"]')].map(b => b.textContent.trim() + (b.getAttribute('aria-selected') === 'true' ? '*' : '')).join('|'),
      }))()`));
      await sleep(250);
    }
    console.log('LIBRARY SAMPLES');
    samples.forEach((s) => console.log(JSON.stringify(s)));

    // 点击「电影」
    const clicked = await page.eval(`(() => {
      const b = [...document.querySelectorAll('[role="tab"]')].find(n => n.textContent.trim() === '电影');
      if (!b) return 'no-tab';
      b.click();
      return 'clicked';
    })()`);
    console.log('click movie tab:', clicked);
    for (let i = 0; i < 12; i++) {
      await sleep(300);
      const s = await page.eval(`(() => ({
        cards: document.querySelectorAll('.poster-card').length,
        tabs: [...document.querySelectorAll('[role="tab"]')].map(b => b.textContent.trim() + (b.getAttribute('aria-selected') === 'true' ? '*' : '')).join('|'),
        titles: [...document.querySelectorAll('.poster-card')].map(n => (n.querySelector('[class*="title"]')||{}).textContent?.trim()).slice(0, 14),
      }))()`);
      console.log('after movie', JSON.stringify(s));
    }

    // 直接检查 store 状态
    const storeState = await page.eval(`(() => {
      const app = document.querySelector('#app').__vue_app__;
      return 'has-app:' + !!app;
    })()`);
    console.log('store:', storeState);

    // 详情 → 播放 → 暂停于 40% → 检查 history
    await page.eval(`location.hash = '#/library'`);
    await sleep(3000);
    await page.eval(`document.querySelector('.poster-card').click()`);
    await sleep(4000);
    await page.eval(`document.querySelector('.detail-actions__main').click()`);
    await sleep(6000);
    const p1 = await page.eval(`(() => { const v = document.querySelector('video'); return v ? { d: v.duration, ct: v.currentTime, paused: v.paused } : null; })()`);
    console.log('player initial', JSON.stringify(p1));
    await page.eval(`(() => { const v = document.querySelector('video'); v.currentTime = v.duration * 0.4; v.pause(); return true; })()`);
    await sleep(3000);
    const hist = await page.eval(`new Promise((resolve) => {
      const req = indexedDB.open('cinema-db');
      req.onsuccess = () => {
        const all = req.result.transaction('history','readonly').objectStore('history').getAll();
        all.onsuccess = () => resolve(all.result);
      };
    })`);
    console.log('history rows', JSON.stringify(hist, null, 2));

    // 回到首页看继续观看
    await page.eval(`history.back()`);
    await sleep(2500);
    await page.eval(`history.back()`);
    await sleep(3500);
    const home = await page.eval(`(() => ({
      hash: location.hash,
      continueSection: !!document.querySelector('#home-continue'),
      cards: document.querySelectorAll('.poster-card').length,
      text: document.body.textContent.replace(/\\s+/g,' ').slice(0,200),
    }))()`);
    console.log('home after play', JSON.stringify(home));

    console.log('CONSOLE ERRORS', logs.slice(0, 20));
    fs.writeFileSync('docs/03-设计规范/preview/review-debug.json', JSON.stringify({ samples, hist, home, logs }, null, 2));
  } finally {
    chrome.kill();
  }
}
main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
