/** 备份导出 + 下载按钮 + 分类缓存 三项定点核查 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE = 'http://localhost:5175';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9447;
const PROFILE = path.join(os.tmpdir(), `peanutmov-probe-${Date.now()}`);
const DL = path.join(os.tmpdir(), `peanutmov-probe-dl-${Date.now()}`);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 40000);
    });
  }
  on(m, fn) { if (!this.listeners.has(m)) this.listeners.set(m, []); this.listeners.get(m).push(fn); }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + e.slice(0, 120));
    return r.result.value;
  }
}

(async () => {
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--disable-gpu', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
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
    const events = [];
    page.on('Page.downloadWillBegin', (p) => events.push(['begin', p.suggestedFilename]));
    page.on('Page.downloadProgress', (p) => events.push(['progress', p.state, p.receivedBytes]));
    page.on('Runtime.exceptionThrown', (p) => events.push(['exc', p.exceptionDetails?.exception?.description]));
    page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') events.push(['console', (p.args || []).map(a => a.value ?? a.description).join(' ')]); });
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

    await page.send('Page.navigate', { url: `${BASE}/#/welcome` });
    await sleep(2500);
    await page.eval(`[...document.querySelectorAll('button')].find(b=>/我已阅读并同意/.test(b.textContent||''))?.click()`);
    await sleep(4000);

    // A. 分类缓存核查：直接读 store 状态
    await page.eval(`location.hash = '#/library'`);
    await sleep(3000);
    const before = await page.eval(`({ cards: document.querySelectorAll('.poster-card').length })`);
    await page.eval(`[...document.querySelectorAll('[role="tab"]')].find(b=>b.textContent.trim()==='电影')?.click()`);
    await sleep(2000);
    const afterMovie = await page.eval(`(() => ({
      cards: document.querySelectorAll('.poster-card').length,
      types: [...document.querySelectorAll('.poster-card')].map(n => n.textContent.replace(/\\s+/g,' ').trim()).slice(0,4),
    }))()`);
    // 强制刷新（refresh=true）后看是否过滤
    await page.eval(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='刷新')?.click()`);
    await sleep(2500);
    const afterRefresh = await page.eval(`({ cards: document.querySelectorAll('.poster-card').length })`);
    console.log('CATEGORY before', JSON.stringify(before), 'afterMovie', JSON.stringify(afterMovie), 'afterRefresh', JSON.stringify(afterRefresh));

    // B. 详情页下载按钮 aria-label
    await page.eval(`location.hash = '#/library'`);
    await sleep(2500);
    await page.eval(`document.querySelector('.poster-card').click()`);
    await sleep(4000);
    const detail = await page.eval(`(() => ({
      title: (document.querySelector('.detail-hero__title')||{}).textContent,
      aria: [...document.querySelectorAll('.detail-actions__icon')].map(b => b.getAttribute('aria-label')),
      chips: document.querySelectorAll('.episode-chip').length,
      count: (document.querySelector('.detail-section__count')||{}).textContent,
    }))()`);
    console.log('DETAIL', JSON.stringify(detail));

    // C. 备份导出
    await page.eval(`location.hash = '#/settings/backup'`);
    await sleep(3000);
    const btn = await page.eval(`[...document.querySelectorAll('button')].some(b => /导出备份文件/.test(b.textContent||''))`);
    await page.eval(`[...document.querySelectorAll('button')].find(b => /导出备份文件/.test(b.textContent||''))?.click()`);
    await sleep(4000);
    console.log('BACKUP clicked=', btn, 'files=', fs.readdirSync(DL), 'events=', JSON.stringify(events.slice(-8)));
    const bodyText = await page.eval(`document.body.textContent.replace(/\\s+/g,' ').slice(0, 300)`);
    console.log('BACKUP page text:', bodyText);

    // D. 下载功能：走播放页下载按钮
    await page.eval(`location.hash = '#/library'`);
    await sleep(2500);
    await page.eval(`document.querySelector('.poster-card').click()`);
    await sleep(3500);
    await page.eval(`document.querySelector('.detail-actions__main').click()`);
    await sleep(6000);
    const playerAria = await page.eval(`[...document.querySelectorAll('[aria-label]')].map(n => n.getAttribute('aria-label')).filter(Boolean)`);
    console.log('PLAYER aria labels:', JSON.stringify(playerAria));
    await page.eval(`[...document.querySelectorAll('[aria-label]')].find(n => n.getAttribute('aria-label')==='下载本集')?.click()`);
    await sleep(1500);
    const sheet = await page.eval(`document.body.textContent.replace(/\\s+/g,' ').slice(0, 200)`);
    console.log('AFTER download click:', sheet);
    await page.eval(`[...document.querySelectorAll('button')].find(b => /开始下载/.test(b.textContent||''))?.click()`);
    await sleep(3000);
    const tasks = await page.eval(`new Promise((resolve) => {
      const req = indexedDB.open('cinema-db');
      req.onsuccess = () => {
        const all = req.result.transaction('downloads','readonly').objectStore('downloads').getAll();
        all.onsuccess = () => resolve(all.result.map(t => ({ s: t.status, f: t.format, e: t.errorCode, m: t.errorMessage, b: t.downloadedBytes, t: t.totalBytes, blob: t.blobKey })));
      };
      req.onerror = () => resolve([]);
    })`);
    console.log('DOWNLOAD TASKS', JSON.stringify(tasks));
    await sleep(12000);
    const tasks2 = await page.eval(`new Promise((resolve) => {
      const req = indexedDB.open('cinema-db');
      req.onsuccess = () => {
        const all = req.result.transaction('downloads','readonly').objectStore('downloads').getAll();
        all.onsuccess = () => resolve(all.result.map(t => ({ s: t.status, e: t.errorCode, b: t.downloadedBytes, blob: t.blobKey })));
      };
      req.onerror = () => resolve([]);
    })`);
    console.log('DOWNLOAD TASKS after 12s', JSON.stringify(tasks2));
    console.log('EVENTS', JSON.stringify(events.slice(0, 20)));
  } finally {
    chrome.kill();
  }
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
