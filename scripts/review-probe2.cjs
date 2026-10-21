/** 定点验证：清空数据 / 备份导入 / 下载续传 / HLS / 错误面板 / 离线播放 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE = 'http://localhost:5175';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9448;
const PROFILE = path.join(os.tmpdir(), `peanutmov-probe2-${Date.now()}`);
const DL = path.join(os.tmpdir(), `peanutmov-probe2-dl-${Date.now()}`);
fs.mkdirSync(DL, { recursive: true });
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
  async eval(e, timeoutMs = 20000) {
    const r = await Promise.race([
      this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true }),
      sleep(timeoutMs).then(() => { throw new Error('EVAL TIMEOUT ' + e.slice(0, 90)); }),
    ]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + e.slice(0, 100));
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
  const net = [];
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
    page.on('Network.requestWillBeSent', (p) => net.push(p.request.url));
    page.on('Runtime.exceptionThrown', (p) => console.log('EXC', p.exceptionDetails?.exception?.description?.slice(0, 200)));
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

    await page.send('Page.navigate', { url: `${BASE}/#/welcome` });
    await sleep(2500);
    await page.eval(`[...document.querySelectorAll('button')].find(b=>/我已阅读并同意/.test(b.textContent||''))?.click()`);
    await sleep(4500);
    console.log('SOURCES after seed', (await page.eval(IDB('sources'))).length, 'MEDIA', (await page.eval(IDB('media'))).length);

    /* ========== A. HLS 线路播放（AC-38 / AC-54） ========== */
    await page.eval(`location.hash = '#/library'`);
    await sleep(2500);
    await page.eval(`[...document.querySelectorAll('.poster-card')].find(n => /Sintel/.test(n.textContent||''))?.click()`);
    await sleep(4000);
    const lineBtns = await page.eval(`[...document.querySelectorAll('[class*="line"] button')].map(b => b.textContent.trim())`);
    console.log('LINES', JSON.stringify(lineBtns));
    const hlsClicked = await page.eval(`(() => {
      const b = [...document.querySelectorAll('[class*="line"] button')].find(x => /HLS/.test(x.textContent||''));
      if (!b) return false; b.click(); return true;
    })()`);
    await sleep(1500);
    await page.eval(`document.querySelector('.detail-actions__main').click()`);
    await sleep(9000);
    const hlsState = await page.eval(`(() => {
      const v = document.querySelector('video');
      return { has: !!v, rs: v?.readyState, d: v ? Number(v.duration.toFixed(2)) : null, err: !!document.querySelector('[class*="error-panel"]'), q: (document.querySelector('[class*="quality"]')||{}).textContent?.trim() };
    })()`);
    console.log('HLS click=', hlsClicked, 'state', JSON.stringify(hlsState));
    const qOpened = await page.eval(`(() => { const b=[...document.querySelectorAll('[aria-label]')].find(n=>n.getAttribute('aria-label')==='清晰度'); if(!b) return false; b.click(); return true; })()`);
    await sleep(1200);
    const qualitySheet = await page.eval(`document.body.textContent.replace(/\\s+/g,' ').slice(-260)`);
    console.log('QUALITY sheet', qOpened, qualitySheet);
    await page.eval(`(() => { const b=[...document.querySelectorAll('button')].find(n=>/自动/.test(n.textContent||'')); b && b.click(); return true; })()`);
    await sleep(800);

    /* ========== B. 下载暂停 / 继续（AC-73） ========== */
    // 从播放页下载当前 HLS 集应被拒绝；改用 MP4 线路
    await page.eval(`location.hash = '#/library'`);
    await sleep(2500);
    await page.eval(`[...document.querySelectorAll('.poster-card')].find(n => /Tears of Steel/.test(n.textContent||''))?.click()`);
    await sleep(3500);
    const detailInfo = await page.eval(`(() => ({ title: (document.querySelector('.detail-hero__title')||{}).textContent, aria: [...document.querySelectorAll('.detail-actions__icon')].map(b=>b.getAttribute('aria-label')), count: (document.querySelector('.detail-section__count')||{}).textContent }))()`);
    console.log('DETAIL', JSON.stringify(detailInfo));
    const dlOpened = await page.eval(`(() => { const b=[...document.querySelectorAll('[aria-label]')].find(n=>/下载/.test(n.getAttribute('aria-label')||'')); if(!b) return false; b.click(); return true; })()`);
    await sleep(900);
    const allSel = await page.eval(CLICK('全选'));
    await sleep(300);
    const started = await page.eval(CLICK('开始下载'));
    await sleep(2500);
    let tasks = await page.eval(IDB('downloads'));
    console.log('DL created', dlOpened, allSel, started, JSON.stringify(tasks.map(t => ({ s: t.status, r: t.resumable, b: t.downloadedBytes, t: t.totalBytes, f: t.format }))));

    // 等下载到 >10% 后暂停
    let pausedInfo = null;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      tasks = await page.eval(IDB('downloads'));
      const t0 = tasks[0];
      if (t0 && t0.downloadedBytes > 2_000_000) break;
    }
    await page.eval(`location.hash = '#/downloads'`);
    await sleep(2500);
    const pauseClicked = await page.eval(`(() => { const b=[...document.querySelectorAll('[aria-label="暂停"]')][0]; if(!b) return false; b.click(); return true; })()`);
    await sleep(1500);
    tasks = await page.eval(IDB('downloads'));
    const beforeResume = tasks.map(t => ({ s: t.status, r: t.resumable, b: t.downloadedBytes }));
    console.log('PAUSE', pauseClicked, JSON.stringify(beforeResume));
    await page.eval(`(() => { const b=[...document.querySelectorAll('[aria-label="继续"]')][0]; if(!b) return false; b.click(); return true; })()`);
    await sleep(4000);
    tasks = await page.eval(IDB('downloads'));
    console.log('AFTER RESUME', JSON.stringify(tasks.map(t => ({ s: t.status, r: t.resumable, b: t.downloadedBytes }))));

    /* ========== C. 清空全部数据（AC-99） ========== */
    await page.eval(`location.hash = '#/settings'`);
    await sleep(2500);
    await page.eval(CLICK('清空全部数据'));
    await sleep(800);
    const confirmClicked = await page.eval(CLICK('确认清空'));
    let clearResult = 'unknown';
    try {
      await sleep(6000);
      clearResult = JSON.stringify({
        sources: (await page.eval(IDB('sources'))).length,
        media: (await page.eval(IDB('media'))).length,
        history: (await page.eval(IDB('history'))).length,
        favorites: (await page.eval(IDB('favorites'))).length,
        downloads: (await page.eval(IDB('downloads'))).length,
        text: (await page.eval(`document.body.textContent.replace(/\\s+/g,' ').slice(0, 160)`)),
      });
    } catch (e) {
      clearResult = 'ERROR ' + e.message;
    }
    console.log('CLEAR ALL', confirmClicked, clearResult);

    /* ========== D. 错误面板（AC-39） ========== */
    await page.send('Network.setBlockedURLs', { urls: ['*mdn.github.io*', '*plyr.io*', '*zencdn.net*'] });
    await page.eval(`location.hash = '#/library'`);
    await sleep(3000);
    const clickCard = await page.eval(`(() => { const c = document.querySelector('.poster-card'); if(!c) return false; c.click(); return true; })()`);
    await sleep(4000);
    await page.eval(`document.querySelector('.detail-actions__main')?.click()`);
    await sleep(12000);
    const errState = await page.eval(`(() => ({
      panel: !!document.querySelector('[class*="error-panel"]'),
      text: (document.querySelector('[class*="error-panel"]')||{}).textContent?.replace(/\\s+/g,' ').slice(0, 160) || null,
      loadError: (document.querySelector('.player-loading')||{}).textContent?.replace(/\\s+/g,' ').slice(0, 160) || null,
    }))()`);
    console.log('ERROR PANEL', clickCard, JSON.stringify(errState));
    await page.send('Network.setBlockedURLs', { urls: [] });
  } finally {
    chrome.kill();
  }
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
