/** 定点验证 2：清空数据挂起 / 下载暂停续传 / 错误面板 / 后台暂停 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE = 'http://localhost:5175';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9449;
const PROFILE = path.join(os.tmpdir(), `peanutmov-probe3-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
        return;
      }
      for (const fn of this.listeners.get(m.method) ?? []) fn(m.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout ' + method)); } }, 25000);
    });
  }
  on(m, fn) { if (!this.listeners.has(m)) this.listeners.set(m, []); this.listeners.get(m).push(fn); }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + e.slice(0, 120));
    return r.result.value;
  }
}

const IDB = (store) => `new Promise((resolve) => {
  const req = indexedDB.open('cinema-db');
  req.onsuccess = () => {
    const all = req.result.transaction(${JSON.stringify(store)},'readonly').objectStore(${JSON.stringify(store)}).getAll();
    all.onsuccess = () => resolve(all.result);
    all.onerror = () => resolve([]);
  };
  req.onerror = () => resolve([]);
})`;

const CLICK = (t) => `(() => {
  const want = ${JSON.stringify(t)};
  const n = [...document.querySelectorAll('button, a, [role="button"]')].find(x => (x.textContent||'').replace(/\\s+/g,'').includes(want.replace(/\\s+/g,'')) && x.offsetParent !== null);
  if (!n) return false; n.click(); return true;
})()`;

(async () => {
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
  const consoleMsgs = [];
  try {
    for (let i = 0; i < 80; i++) { try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(200); } }
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
    page.on('Runtime.consoleAPICalled', (p) => consoleMsgs.push(`[${p.type}] ` + (p.args || []).map(a => a.value ?? a.description).join(' ')));
    page.on('Runtime.exceptionThrown', (p) => consoleMsgs.push('[exc] ' + p.exceptionDetails?.exception?.description?.slice(0, 300)));
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

    await page.send('Page.navigate', { url: `${BASE}/#/welcome` });
    await sleep(2500);
    await page.eval(`[...document.querySelectorAll('button')].find(b=>/我已阅读并同意/.test(b.textContent||''))?.click()`);
    await sleep(4500);

    /* 造一条历史 + 一条下载任务 */
    await page.eval(`location.hash = '#/library'`);
    await sleep(2500);
    await page.eval(`document.querySelector('.poster-card').click()`);
    await sleep(4000);
    await page.eval(`document.querySelector('.detail-actions__main').click()`);
    await sleep(7000);
    await page.eval(`(() => { const v=document.querySelector('video'); v.currentTime = v.duration*0.3; v.pause(); return true; })()`);
    await sleep(2000);
    await page.eval(`[...document.querySelectorAll('[aria-label]')].find(n=>n.getAttribute('aria-label')==='下载本集')?.click()`);
    await sleep(1000);
    await page.eval(CLICK('开始下载'));
    await sleep(3000);
    console.log('BEFORE CLEAR', JSON.stringify({
      history: (await page.eval(IDB('history'))).length,
      downloads: (await page.eval(IDB('downloads'))).length,
    }));

    /* 清空全部数据：观察是否挂起 */
    await page.eval(`location.hash = '#/settings'`);
    await sleep(2500);
    await page.eval(CLICK('清空全部数据'));
    await sleep(900);
    const opened = await page.eval(`!!document.querySelector('.sheet, [class*="sheet"]')`);
    await page.eval(CLICK('确认清空'));
    for (let i = 1; i <= 8; i++) {
      await sleep(1500);
      const s = await page.eval(`(() => ({
        busy: !!document.querySelector('.spinner, [class*="spinner"]'),
        text: document.body.textContent.replace(/\\s+/g,' ').slice(0, 80),
      }))()`);
      let counts = {};
      try {
        counts = await page.eval(`Promise.race([
          new Promise((resolve) => {
            const req = indexedDB.open('cinema-db');
            req.onsuccess = () => {
              const db = req.result;
              const out = {};
              const stores = ['sources','media','history','favorites','downloads'];
              let left = stores.length;
              stores.forEach((name) => {
                const c = db.transaction(name,'readonly').objectStore(name).count();
                c.onsuccess = () => { out[name] = c.result; if (--left === 0) resolve(out); };
                c.onerror = () => { out[name] = -1; if (--left === 0) resolve(out); };
              });
            };
            req.onerror = () => resolve({ err: 1 });
          }),
          new Promise((r) => setTimeout(() => r({ timeout: true }), 2000)),
        ])`);
      } catch (e) {
        counts = { evalError: e.message };
      }
      console.log(`CLEAR +${i * 1.5}s`, opened, JSON.stringify(s), JSON.stringify(counts));
    }

    /* 下载暂停/继续（正确 aria） */
    await page.eval(`location.hash = '#/downloads'`);
    await sleep(2500);
    const labels = await page.eval(`[...document.querySelectorAll('.download-item [aria-label]')].map(n=>n.getAttribute('aria-label'))`);
    console.log('DL aria', JSON.stringify(labels));
    const paused = await page.eval(`(() => { const b=document.querySelector('[aria-label="暂停下载"]'); if(!b) return false; b.click(); return true; })()`);
    await sleep(1500);
    let tasks = await page.eval(IDB('downloads'));
    console.log('AFTER PAUSE', paused, JSON.stringify(tasks.map(x => ({ s: x.status, r: x.resumable, b: x.downloadedBytes }))));
    const resumed = await page.eval(`(() => { const b=document.querySelector('[aria-label="继续下载"]'); if(!b) return false; b.click(); return true; })()`);
    await sleep(3000);
    tasks = await page.eval(IDB('downloads'));
    console.log('AFTER RESUME', resumed, JSON.stringify(tasks.map(x => ({ s: x.status, r: x.resumable, b: x.downloadedBytes }))));

    /* 后台可见性 → 是否暂停下载（FR-31） */
    await page.eval(`document.dispatchEvent(new Event('visibilitychange'))`);
    await sleep(1500);
    tasks = await page.eval(IDB('downloads'));
    console.log('AFTER visibilitychange', JSON.stringify(tasks.map(x => ({ s: x.status }))));

    console.log('CONSOLE', JSON.stringify(consoleMsgs.slice(0, 25), null, 1));
    fs.writeFileSync('docs/03-设计规范/preview/review-debug2.json', JSON.stringify({ consoleMsgs }, null, 2));
  } finally {
    chrome.kill();
  }
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
