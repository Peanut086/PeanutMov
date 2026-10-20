/**
 * 真机尺寸（390x844）headless Chrome 冒烟脚本。
 *
 * 用 CDP 直接驱动（Node 22 内置 WebSocket），不依赖 puppeteer：
 * - 新建 profile 保证 IndexedDB 干净（首启 → 合规门禁）
 * - 逐页截图到 docs/03-设计规范/preview/
 * - 每步收集 console 错误与页面异常，供自测记录引用
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BASE = process.env.BASE_URL || 'http://localhost:5174';
const OUT = process.env.OUT_DIR || path.resolve('docs/03-设计规范/preview');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const PROFILE = path.join(os.tmpdir(), `peanutmov-chrome-${Date.now()}`);

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jsonGet(url) {
  const res = await fetch(url);
  return res.json();
}

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
      const key = msg.method;
      for (const fn of this.listeners.get(key) ?? []) fn(msg.params);
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
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`eval failed: ${res.exceptionDetails.text} :: ${expression.slice(0, 160)}`);
    }
    return res.result.value;
  }
}

async function connect() {
  const version = await jsonGet(`http://127.0.0.1:${PORT}/json/version`);
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  const { targetId } = await cdp.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId,
  });
  const list = await jsonGet(`http://127.0.0.1:${PORT}/json/list`);
  const target = list.find((t) => t.id === targetId);
  const pws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    pws.addEventListener('open', resolve, { once: true });
    pws.addEventListener('error', reject, { once: true });
  });
  const page = new Cdp(pws);
  const logs = [];
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning') {
      logs.push(`[${p.type}] ${(p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
    }
  });
  page.on('Runtime.exceptionThrown', (p) => {
    logs.push(`[exception] ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
  });
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  return { page, logs, asBrowser: () => cdp.send('Browser.close') };
}

async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

/** 点击「可见文本包含 text」的 button/a/[role=button]，返回是否命中 */
const CLICK = (text) => `(() => {
  const want = ${JSON.stringify(text)};
  const nodes = [...document.querySelectorAll('button, a, [role="button"]')];
  const hit = nodes.find((n) => (n.textContent || '').replace(/\\s+/g, '').includes(want.replace(/\\s+/g, '')) && n.offsetParent !== null);
  if (!hit) return false;
  hit.click();
  return true;
})()`;

async function waitRoute(page, hash, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await page.eval(`location.hash === '#${hash}'`);
    if (ok) return true;
    await sleep(120);
  }
  throw new Error(`route not reached: ${hash} (now ${await page.eval('location.hash')})`);
}

async function waitFor(page, expr, timeout = 10000, label = expr) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.eval(expr)) return true;
    await sleep(150);
  }
  throw new Error(`timeout waiting: ${label}`);
}

(async () => {
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=390,844',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const report = { steps: [], logs: [] };
  const step = (name, detail) => {
    report.steps.push({ name, detail });
    console.log(`- ${name}: ${detail}`);
  };

  try {
    // 等待 CDP 就绪
    for (let i = 0; i < 60; i += 1) {
      try {
        await jsonGet(`http://127.0.0.1:${PORT}/json/version`);
        break;
      } catch {
        await sleep(250);
      }
    }

    const { page, logs } = await connect();

    // 1) 首启：/welcome
    await page.send('Page.navigate', { url: `${BASE}/#/welcome` });
    await waitFor(page, `!!document.querySelector('[data-route="welcome"]')`, 15000, 'welcome view');
    await sleep(600);
    step('welcome', await shot(page, '01-welcome'));

    // 2) 同意合规 → 首页
    const clickedAgree = await page.eval(CLICK('我已阅读并同意'));
    if (!clickedAgree) throw new Error('未找到「我已阅读并同意」按钮');
    await waitRoute(page, '/');
    await waitFor(page, `!!document.querySelector('[data-route="home"]')`, 15000, 'home view');
    await waitFor(page, `document.querySelectorAll('.poster-card, [data-route="home"] a[href*="detail"]').length >= 4`, 20000, 'home posters');
    await sleep(800);
    step('home', await shot(page, '02-home'));

    report.home = await page.eval(`(() => {
      const cards = document.querySelectorAll('.poster-card');
      const hasContinue = !!document.querySelector('[class*="continue"]');
      const tabbar = !!document.querySelector('.tabbar');
      const titles = [...document.querySelectorAll('.poster-card')].slice(0, 3).map((n) => n.textContent.trim());
      return { cards: cards.length, hasContinue, tabbar, titles };
    })()`);

    // 3) 媒体库
    await page.eval(`location.hash = '#/library'`);
    await waitRoute(page, '/library');
    await waitFor(page, `document.querySelectorAll('.poster-card').length >= 12`, 20000, 'library 12 posters');
    await sleep(700);
    step('library', await shot(page, '03-library'));
    report.library = await page.eval(`(() => {
      const cards = [...document.querySelectorAll('.poster-card')];
      return {
        count: cards.length,
        tabs: [...document.querySelectorAll('[class*="category"] button')].map((b) => b.textContent.trim()).slice(0, 8),
        source: (document.querySelector('[class*="library-toolbar__value"]') || {}).textContent || null,
        titles: cards.slice(0, 4).map((n) => n.textContent.trim()),
      };
    })()`);

    // 4) 详情（点第一张海报）
    await page.eval(`(() => { const c = document.querySelector('.poster-card'); c.click(); return true; })()`);
    await waitFor(page, `/#\\/detail\\//.test(location.hash)`, 8000, 'detail route');
    await waitFor(page, `!!document.querySelector('[data-route="detail"]')`, 15000, 'detail view');
    await waitFor(page, `!!document.querySelector('.detail-hero__title')`, 20000, 'detail title');
    await sleep(700);
    step('detail', await shot(page, '04-detail'));
    report.detail = await page.eval(`(() => ({
      hash: location.hash,
      title: (document.querySelector('.detail-hero__title') || {}).textContent || null,
      primary: (document.querySelector('.detail-actions__main') || {}).textContent?.trim() || null,
      episodes: document.querySelectorAll('[class*="episode"]').length,
    }))()`);

    // 5) 播放页（点主按钮）
    await page.eval(`(() => { document.querySelector('.detail-actions__main').click(); return true; })()`);
    await waitFor(page, `/#\\/player\\//.test(location.hash)`, 8000, 'player route');
    await waitFor(page, `!!document.querySelector('[data-route="player"]')`, 15000, 'player view');
    await sleep(4000); // 等视频首帧/加载态结束
    step('player', await shot(page, '05-player'));
    report.player = await page.eval(`(() => {
      const v = document.querySelector('video');
      return {
        hash: location.hash,
        hasVideo: !!v,
        readyState: v ? v.readyState : null,
        duration: v ? Number(v.duration.toFixed(2)) : null,
        paused: v ? v.paused : null,
        title: (document.querySelector('.player-info__title') || {}).textContent || null,
        loadingVisible: !!document.querySelector('.player-loading'),
        errorPanel: !!document.querySelector('[class*="error-panel"]'),
      };
    })()`);

    // 回到详情/媒体库，继续 Pages
    await page.eval(`location.hash = '#/downloads'`);
    await waitRoute(page, '/downloads');
    await waitFor(page, `!!document.querySelector('[data-route="downloads"]')`, 15000, 'downloads view');
    await sleep(900);
    step('downloads', await shot(page, '06-downloads'));
    report.downloads = await page.eval(`(() => ({
      empty: !!document.querySelector('[class*="empty"]'),
      tasks: document.querySelectorAll('[class*="download-item"]').length,
      text: (document.querySelector('[data-route="downloads"]') || {}).textContent?.replace(/\\s+/g, ' ').slice(0, 160) || null,
    }))()`);

    await page.eval(`location.hash = '#/history'`);
    await waitRoute(page, '/history');
    await waitFor(page, `!!document.querySelector('[data-route="history"]')`, 15000, 'history view');
    await sleep(900);
    step('history', await shot(page, '07-history'));
    report.history = await page.eval(`(() => ({
      empty: !!document.querySelector('[class*="empty"]'),
      items: document.querySelectorAll('[class*="history-item"], li[class*="row"]').length,
      text: (document.querySelector('[data-route="history"]') || {}).textContent?.replace(/\\s+/g, ' ').slice(0, 160) || null,
    }))()`);

    await page.eval(`location.hash = '#/favorites'`);
    await waitRoute(page, '/favorites');
    await waitFor(page, `!!document.querySelector('[data-route="favorites"]')`, 15000, 'favorites view');
    await sleep(900);
    step('favorites', await shot(page, '08-favorites'));
    report.favorites = await page.eval(`(() => ({
      empty: !!document.querySelector('[class*="empty"]'),
      cards: document.querySelectorAll('[class*="favorite-card"]').length,
      text: (document.querySelector('[data-route="favorites"]') || {}).textContent?.replace(/\\s+/g, ' ').slice(0, 160) || null,
    }))()`);

    await page.eval(`location.hash = '#/settings'`);
    await waitRoute(page, '/settings');
    await waitFor(page, `!!document.querySelector('[data-route="settings"]')`, 15000, 'settings view');
    await waitFor(page, `!document.querySelector('.settings-loading')`, 15000, 'settings loaded');
    await sleep(700);
    step('settings', await shot(page, '09-settings'));
    report.settings = await page.eval(`(() => ({
      overview: (document.querySelector('.overview__line') || {}).textContent?.trim() || null,
      rows: [...document.querySelectorAll('[class*="settings-row"]')].slice(0, 6).map((n) => n.textContent.replace(/\\s+/g, ' ').trim()),
    }))()`);

    // 源管理 / 搜索 / 备份 / 关于（补充覆盖）
    await page.eval(`location.hash = '#/settings/sources'`);
    await waitRoute(page, '/settings/sources');
    await waitFor(page, `!!document.querySelector('[data-route="sources"]')`, 15000, 'sources view');
    await sleep(1500);
    step('sources', await shot(page, '10-sources'));
    report.sources = await page.eval(`(() => ({
      cards: document.querySelectorAll('[class*="source-card"]').length,
      text: (document.querySelector('[data-route="sources"]') || {}).textContent?.replace(/\\s+/g, ' ').slice(0, 200) || null,
    }))()`);

    await page.eval(`location.hash = '#/search'`);
    await waitRoute(page, '/search');
    await waitFor(page, `!!document.querySelector('input')`, 15000, 'search input');
    await page.eval(`(() => {
      const input = document.querySelector('input');
      input.focus();
      input.value = 'Sintel';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(1800);
    step('search', await shot(page, '11-search'));
    report.search = await page.eval(`(() => ({
      text: (document.querySelector('main') || {}).textContent?.replace(/\\s+/g, ' ').slice(0, 200) || null,
      results: document.querySelectorAll('[class*="result"] , .poster-card').length,
    }))()`);

    await page.eval(`location.hash = '#/settings/backup'`);
    await waitRoute(page, '/settings/backup');
    await waitFor(page, `!!document.querySelector('[data-route="backup"]')`, 15000, 'backup view');
    await sleep(600);
    step('backup', await shot(page, '12-backup'));

    report.logs = logs;
    fs.writeFileSync(path.join(OUT, 'smoke-report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({ ...report, steps: report.steps.map((s) => s.name) }, null, 2));
    process.exitCode = 0;
  } catch (e) {
    console.error('SMOKE FAILED:', e.message);
    report.logs = report.logs ?? [];
    fs.writeFileSync(path.join(OUT, 'smoke-report.json'), JSON.stringify({ ...report, error: e.message }, null, 2));
    process.exitCode = 1;
  } finally {
    try {
      chrome.kill();
    } catch {}
  }
})();
