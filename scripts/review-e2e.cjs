/**
 * 评审&测试用全链路 E2E 脚本 v2（headless Chrome + CDP，无第三方依赖）
 *
 * 覆盖：首启合规 → 首页 → 媒体库（分类/筛选/搜索）→ 详情 → 播放 → 倍速 → 断点续播 →
 *       返回 → 继续观看 → 收藏 → 历史 → 下载（创建/完成/离线播放）→ 设置 →
 *       源管理/新增源 → 订阅导入 → 备份导出/导入 → 404
 *
 * 用法：node scripts/review-e2e.cjs
 * 产物：docs/03-设计规范/preview/review-*.png + review-e2e-report.json
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BASE = process.env.BASE_URL || 'http://localhost:5175';
const OUT = path.resolve('docs/03-设计规范/preview');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9446;
const SUB_PORT = 8801;
const PROFILE = path.join(os.tmpdir(), `peanutmov-review2-${Date.now()}`);
const DL_DIR = path.join(os.tmpdir(), `peanutmov-dl2-${Date.now()}`);

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(DL_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const logs = [];

function record(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name} :: ${String(text).slice(0, 320)}`);
}

async function step(id, name, fn) {
  try {
    const detail = await fn();
    record(id, name, true, detail ?? 'ok');
    return detail;
  } catch (e) {
    record(id, name, false, e.message);
    return null;
  }
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
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 40000);
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
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`eval failed: ${res.exceptionDetails.text} :: ${String(expression).slice(0, 160)}`);
    }
    return res.result.value;
  }
}

async function connect() {
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(ws);
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find((t) => t.id === targetId);
  const pws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    pws.addEventListener('open', resolve, { once: true });
    pws.addEventListener('error', reject, { once: true });
  });
  const page = new Cdp(pws);
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
  await page.send('DOM.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR });
  return { page };
}

async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

async function waitFor(page, expr, timeout = 15000, label = expr) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.eval(expr)) return true;
    await sleep(150);
  }
  throw new Error(`timeout waiting: ${label}`);
}

/** 路由 + 视图就绪（避免把上一页 DOM 当作新页） */
async function goto(page, hash, route, timeout = 20000) {
  await page.eval(`location.hash = ${JSON.stringify(hash)}`);
  await waitFor(page, `location.hash.startsWith(${JSON.stringify(hash)})`, 8000, `hash ${hash}`);
  await waitFor(page, `!!document.querySelector('[data-route="${route}"]')`, timeout, `view ${route}`);
  await sleep(700);
}

const CLICK = (text) => `(() => {
  const want = ${JSON.stringify(text)};
  const nodes = [...document.querySelectorAll('button, a, [role="button"]')];
  const hit = nodes.find((n) => (n.textContent || '').replace(/\\s+/g, '').includes(want.replace(/\\s+/g, '')) && n.offsetParent !== null);
  if (!hit) return false;
  hit.click();
  return true;
})()`;

const CLICK_ARIA = (label) => `(() => {
  const nodes = [...document.querySelectorAll('[aria-label]')];
  const hit = nodes.find((n) => n.getAttribute('aria-label') === ${JSON.stringify(label)} && n.offsetParent !== null);
  if (!hit) return false;
  hit.click();
  return true;
})()`;

const IDB_COUNT = (store) => `new Promise((resolve) => {
  const req = indexedDB.open('cinema-db');
  req.onsuccess = () => {
    const all = req.result.transaction(${JSON.stringify(store)}, 'readonly').objectStore(${JSON.stringify(store)}).count();
    all.onsuccess = () => resolve(all.result);
    all.onerror = () => resolve(-1);
  };
  req.onerror = () => resolve(-1);
})`;

const IDB_ALL = (store) => `new Promise((resolve) => {
  const req = indexedDB.open('cinema-db');
  req.onsuccess = () => {
    const all = req.result.transaction(${JSON.stringify(store)}, 'readonly').objectStore(${JSON.stringify(store)}).getAll();
    all.onsuccess = () => resolve(all.result);
    all.onerror = () => resolve([]);
  };
  req.onerror = () => resolve([]);
})`;

/* ---------- 本地订阅服务（带 CORS） ---------- */
const SUBSCRIPTION = {
  name: '评审测试订阅',
  version: 1,
  sources: [
    { key: 'rev-alist', name: '评审 AList', type: 'alist', api: 'https://alist.example.com' },
    { key: 'rev-webdav', name: '评审 WebDAV', type: 'webdav', api: 'https://nas.example.com/dav' },
    { key: 'rev-bad', name: '评审缺字段', type: 'site' },
  ],
};

function startSubServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.url.startsWith('/sub.json')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(SUBSCRIPTION));
        return;
      }
      res.writeHead(404);
      res.end('nf');
    });
    server.listen(SUB_PORT, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const subServer = await startSubServer();
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
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=390,844',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let page;
  try {
    for (let i = 0; i < 80; i += 1) {
      try {
        await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
        break;
      } catch {
        await sleep(250);
      }
    }
    ({ page } = await connect());

    /* ===== 1. 首启合规 ===== */
    await page.send('Page.navigate', { url: `${BASE}/#/welcome` });
    await waitFor(page, `!!document.querySelector('[data-route="welcome"]')`, 20000, 'welcome');
    await sleep(800);
    await step('E2E-01', '首启合规页含四项要点且无跳过入口', async () => {
      const text = await page.eval(`document.querySelector('[data-route="welcome"]').textContent.replace(/\\s+/g,' ')`);
      const missing = ['不内置', '破解', '授权', '本机'].filter((k) => !text.includes(k));
      if (missing.length) throw new Error(`缺少要点: ${missing.join(',')}`);
      const hasSkip = await page.eval(`[...document.querySelectorAll('button')].some(b => /跳过/.test(b.textContent||''))`);
      if (hasSkip) throw new Error('存在跳过入口');
      await shot(page, 'review-01-welcome');
      return { ok: true };
    });

    await page.eval(CLICK('我已阅读并同意'));
    await waitFor(page, `location.hash === '#/'`, 10000, 'route home');
    await waitFor(page, `document.querySelectorAll('.poster-card').length >= 12`, 25000, 'home posters');
    await sleep(900);

    /* ===== 2. 首页 ===== */
    await step('E2E-02', '首页海报墙 12 条且未播放时无「继续观看」', async () => {
      const p = await page.eval(`(() => ({
        cards: document.querySelectorAll('.poster-card').length,
        continueSection: !!document.querySelector('#home-continue'),
        demoBadges: document.querySelectorAll('.poster-card__badge--demo, [class*="badge--demo"]').length,
      }))()`);
      if (p.cards < 12) throw new Error(`cards=${p.cards}`);
      if (p.continueSection) throw new Error('未播放却出现继续观看区');
      await shot(page, 'review-02-home');
      return p;
    });

    /* ===== 3. 媒体库 ===== */
    await goto(page, '#/library', 'library');
    await waitFor(page, `document.querySelectorAll('.poster-card').length >= 12`, 20000, 'library posters');
    await step('E2E-03', '媒体库 12 条 + 分类 Tab 完整', async () => {
      const p = await page.eval(`(() => ({
        cards: document.querySelectorAll('.poster-card').length,
        tabs: [...document.querySelectorAll('[role="tab"]')].map(b => b.textContent.trim()),
        source: (document.querySelector('.library-toolbar__value')||{}).textContent?.trim() || null,
      }))()`);
      if (p.cards < 12) throw new Error(`cards=${p.cards}`);
      if (!p.tabs.includes('全部')) throw new Error('缺少「全部」Tab');
      await shot(page, 'review-03-library');
      return p;
    });

    /* ===== 4. 分类切换（AC-20 核心） ===== */
    await step('E2E-04', '分类「电影」切换后列表按类型过滤', async () => {
      const before = await page.eval(`document.querySelectorAll('.poster-card').length`);
      await page.eval(CLICK('电影'));
      await sleep(2000);
      const after = await page.eval(`(() => ({
        cards: document.querySelectorAll('.poster-card').length,
        meta: [...document.querySelectorAll('.poster-card')].map(n => (n.querySelector('[class*="meta"]')||{}).textContent?.trim()).slice(0, 6),
        selected: [...document.querySelectorAll('[role="tab"]')].filter(b => b.getAttribute('aria-selected') === 'true').map(b => b.textContent.trim()),
      }))()`);
      await shot(page, 'review-04-library-movie');
      if (after.cards === 0) throw new Error('电影分类为空');
      if (after.cards >= before) throw new Error(`分类未过滤：before=${before} after=${after.cards}，选中=${after.selected}`);
      return { before, after };
    });

    /* ===== 5. 搜索 ===== */
    await goto(page, '#/search', 'search');
    await waitFor(page, `!!document.querySelector('input')`, 10000, 'search input');
    await step('E2E-05', '搜索 "Sintel" 结果条数与列表行数一致', async () => {
      await page.eval(`(() => {
        const input = document.querySelector('input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'Sintel');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(2200);
      const p = await page.eval(`(() => {
        const count = (document.querySelector('.search-section__count')||{}).textContent?.trim() || null;
        const rows = document.querySelectorAll('.result-row').length;
        return { count, rows, empty: !!document.querySelector('[class*="empty-state"]') };
      })()`);
      await shot(page, 'review-05-search');
      if (!p.count) throw new Error('未显示结果计数');
      const n = Number(/(\d+)/.exec(p.count)?.[1] ?? -1);
      if (n !== p.rows) throw new Error(`计数 ${p.count} 与行数 ${p.rows} 不一致`);
      return p;
    });

    /* ===== 6. 详情（Sintel，长片用于续播） ===== */
    await goto(page, '#/library', 'library');
    await waitFor(page, `document.querySelectorAll('.poster-card').length >= 12`, 20000, 'library for detail');
    await page.eval(`(() => {
      const card = [...document.querySelectorAll('.poster-card')].find(n => /Sintel/.test(n.textContent || ''));
      if (!card) throw new Error('no Sintel card');
      card.click();
      return true;
    })()`);
    await waitFor(page, `/#\\/detail\\//.test(location.hash)`, 8000, 'detail route');
    await waitFor(page, `!!document.querySelector('.detail-hero__title')`, 20000, 'detail title');
    await sleep(900);
    await step('E2E-06', '详情页集数文案与集数节点一致（Sintel 双线路）', async () => {
      const p = await page.eval(`(() => ({
        title: (document.querySelector('.detail-hero__title')||{}).textContent?.trim() || null,
        count: (document.querySelector('.detail-section__count')||{}).textContent?.trim() || null,
        chips: document.querySelectorAll('.episode-chip').length,
        lines: document.querySelectorAll('[class*="line-selector"] button, .line-selector button').length,
        descToggle: !!document.querySelector('.detail-desc__toggle'),
        compliance: /不提供任何影视片源/.test(document.body.textContent || ''),
      }))()`);
      const m = /共\s*(\d+)\s*集/.exec(p.count || '');
      if (!m) throw new Error(`未找到集数文案: ${p.count}`);
      if (Number(m[1]) !== p.chips) throw new Error(`文案 ${m[1]} 集 vs 节点 ${p.chips}`);
      await shot(page, 'review-06-detail');
      return p;
    });

    /* ===== 7. 收藏 ===== */
    await step('E2E-07', '详情页收藏 → aria-pressed 变 true', async () => {
      if (!(await page.eval(CLICK_ARIA('收藏')))) throw new Error('未找到收藏按钮');
      await sleep(900);
      const pressed = await page.eval(`document.querySelector('[aria-label="取消收藏"]')?.getAttribute('aria-pressed')`);
      if (pressed !== 'true') throw new Error(`aria-pressed=${pressed}`);
      const cnt = await page.eval(IDB_COUNT('favorites'));
      if (cnt !== 1) throw new Error(`favorites 表条数=${cnt}`);
      await shot(page, 'review-07-detail-favorited');
      return { pressed, cnt };
    });

    /* ===== 8. 播放 ===== */
    await page.eval(`document.querySelector('.detail-actions__main').click()`);
    await waitFor(page, `/#\\/player\\//.test(location.hash)`, 10000, 'player route');
    await waitFor(page, `!!document.querySelector('video')`, 20000, 'video element');
    await waitFor(
      page,
      `(() => { const v=document.querySelector('video'); return v && v.readyState >= 2 && v.duration > 0; })()`,
      30000,
      'video metadata',
    );
    await sleep(1200);
    let duration = 0;
    await step('E2E-08', '播放页出画（readyState≥2 且有 duration）', async () => {
      const p = await page.eval(`(() => {
        const v = document.querySelector('video');
        return {
          hasVideo: !!v, readyState: v?.readyState ?? null,
          duration: v ? Number(v.duration.toFixed(2)) : null,
          errorPanel: !!document.querySelector('[class*="error-panel"]'),
          loading: !!document.querySelector('.player-loading'),
        };
      })()`);
      if (!p.hasVideo) throw new Error('无 video');
      if (!(p.readyState >= 2)) throw new Error(`readyState=${p.readyState}`);
      if (!(p.duration > 0)) throw new Error(`duration=${p.duration}`);
      if (p.errorPanel) throw new Error('出现错误面板');
      duration = p.duration;
      await shot(page, 'review-08-player');
      return p;
    });

    /* ===== 9. 倍速 ===== */
    await step('E2E-09', '倍速 1.5x 生效且进度不跳变', async () => {
      const before = await page.eval(`document.querySelector('video').currentTime`);
      await page.eval(`document.querySelector('.player-controls')?.classList.add('player-controls--visible')`);
      if (!(await page.eval(CLICK_ARIA('倍速')))) throw new Error('未找到倍速按钮');
      await sleep(400);
      if (!(await page.eval(CLICK('1.5x')))) throw new Error('未找到 1.5x 选项');
      await sleep(600);
      const p = await page.eval(`(() => { const v = document.querySelector('video'); return { rate: v.playbackRate, t: v.currentTime }; })()`);
      if (Math.abs(p.rate - 1.5) > 0.001) throw new Error(`playbackRate=${p.rate}`);
      if (Math.abs(p.t - before) > 1.5) throw new Error(`进度跳变 ${before}→${p.t}`);
      await shot(page, 'review-09-speed');
      return p;
    });

    /* ===== 10. 断点续播写回（AC-50） ===== */
    await step('E2E-10', '暂停在 40% 后历史写回（positionSec 与进度）', async () => {
      await page.eval(`(() => {
        const v = document.querySelector('video');
        v.currentTime = v.duration * 0.4;
        v.play().catch(() => {});
        return true;
      })()`);
      await sleep(2500);
      await page.eval(`(() => { document.querySelector('video').pause(); return true; })()`);
      await sleep(2000);
      const rows = await page.eval(IDB_ALL('history'));
      if (!rows.length) throw new Error('history 表无记录');
      const r = rows[0];
      const ratio = r.positionSec / r.durationSec;
      if (!(ratio > 0.3 && ratio < 0.6)) throw new Error(`进度=${ratio.toFixed(2)}（期望 ~0.4）`);
      if (r.finished) throw new Error('40% 被误标为已看完');
      return { positionSec: Number(r.positionSec.toFixed(1)), durationSec: Number(r.durationSec.toFixed(1)), progress: Number(r.progress.toFixed(2)) };
    });

    /* ===== 11. 返回详情：继续观看按钮（AC-36） ===== */
    await page.eval(`document.querySelector('[aria-label="返回"]').click()`);
    await waitFor(page, `/#\\/detail\\//.test(location.hash)`, 8000, 'back detail');
    await waitFor(page, `!!document.querySelector('.detail-actions__main')`, 15000, 'detail primary');
    await sleep(1200);
    await step('E2E-11', '返回详情主按钮显示「继续观看 · 第 N 集」', async () => {
      const primary = await page.eval(`document.querySelector('.detail-actions__main').textContent.replace(/\\s+/g,' ').trim()`);
      await shot(page, 'review-10-detail-continue');
      if (!primary.includes('继续观看')) throw new Error(`primary=${primary}`);
      return { primary };
    });

    /* ===== 12. 续播位置恢复（AC-36 ±2s） ===== */
    await step('E2E-12', '再次进入播放页从记录位置续播（±2s）', async () => {
      const recorded = await page.eval(IDB_ALL('history')).then((rows) => rows[0]);
      await page.eval(`document.querySelector('.detail-actions__main').click()`);
      await waitFor(page, `/#\\/player\\//.test(location.hash)`, 10000, 'player again');
      await waitFor(page, `(() => { const v=document.querySelector('video'); return v && v.readyState >= 2 && v.duration > 0; })()`, 30000, 'video again');
      await sleep(1500);
      const t = await page.eval(`document.querySelector('video').currentTime`);
      await shot(page, 'review-11-player-resume');
      if (Math.abs(t - recorded.positionSec) > 2.5) throw new Error(`起播 ${t.toFixed(1)}s vs 记录 ${recorded.positionSec.toFixed(1)}s`);
      return { start: Number(t.toFixed(1)), recorded: Number(recorded.positionSec.toFixed(1)) };
    });

    /* ===== 13. 首页继续观看（AC-63） ===== */
    await goto(page, '#/', 'home');
    await waitFor(page, `document.querySelectorAll('.poster-card').length >= 1`, 20000, 'home content');
    await sleep(1200);
    await step('E2E-13', '播放后首页出现「继续观看」横滑区且可点', async () => {
      const p = await page.eval(`(() => ({
        section: !!document.querySelector('#home-continue'),
        cards: document.querySelectorAll('.continue-card').length,
        meta: (document.querySelector('.continue-card__meta')||{}).textContent?.trim() || null,
      }))()`);
      await shot(page, 'review-12-home-continue');
      if (!p.section) throw new Error('继续观看区未出现');
      if (p.cards < 1) throw new Error('继续观看卡片为 0');
      return p;
    });

    /* ===== 14. 历史页 ===== */
    await goto(page, '#/history', 'history');
    await step('E2E-14', '历史页 1 条记录、含集号/进度/分组', async () => {
      const p = await page.eval(`(() => ({
        rows: document.querySelectorAll('.history-row').length,
        groups: [...document.querySelectorAll('.history-group__title')].map(n => n.textContent.trim()),
        text: document.querySelector('[data-route="history"]').textContent.replace(/\\s+/g,' ').slice(0, 100),
      }))()`);
      await shot(page, 'review-13-history');
      if (p.rows !== 1) throw new Error(`rows=${p.rows}`);
      if (!/第\s*\d+\s*集/.test(p.text)) throw new Error(`缺少集号: ${p.text}`);
      return p;
    });

    /* ===== 15. 收藏页 ===== */
    await goto(page, '#/favorites', 'favorites');
    await step('E2E-15', '收藏页显示 1 条收藏', async () => {
      const p = await page.eval(`(() => ({
        cards: document.querySelectorAll('[class*="favorite-card"]').length,
        text: document.querySelector('[data-route="favorites"]').textContent.replace(/\\s+/g,' ').slice(0, 80),
      }))()`);
      await shot(page, 'review-14-favorites');
      if (p.cards < 1) throw new Error(`cards=${p.cards}`);
      return p;
    });

    /* ===== 16. 下载创建 ===== */
    await goto(page, '#/library', 'library');
    await waitFor(page, `document.querySelectorAll('.poster-card').length >= 12`, 20000, 'library for dl');
    await page.eval(`(() => {
      const card = [...document.querySelectorAll('.poster-card')].find(n => /Sintel/.test(n.textContent || ''));
      card.click();
      return true;
    })()`);
    await waitFor(page, `!!document.querySelector('.detail-hero__title')`, 20000, 'detail for dl');
    await sleep(800);
    await step('E2E-16', '详情页选择集数下载并生成任务（AC-69）', async () => {
      if (!(await page.eval(CLICK_ARIA('选择集数下载')))) throw new Error('未找到下载按钮');
      await sleep(700);
      if (!(await page.eval(CLICK('全选')))) throw new Error('未找到全选');
      await sleep(300);
      if (!(await page.eval(CLICK('开始下载')))) throw new Error('未找到开始下载');
      await sleep(2500);
      const tasks = await page.eval(IDB_ALL('downloads'));
      await shot(page, 'review-15-detail-download');
      if (!tasks.length) throw new Error('downloads 表无任务');
      return tasks.map((t) => ({ status: t.status, format: t.format, total: t.totalBytes, sink: t.sink }));
    });

    /* ===== 17. 下载完成 ===== */
    await goto(page, '#/downloads', 'downloads');
    await step('E2E-17', '下载任务完成并写 blobKey（Web 落盘）', async () => {
      const start = Date.now();
      let done = [];
      while (Date.now() - start < 90000) {
        done = await page.eval(IDB_ALL('downloads'));
        if (done.some((t) => t.status === 'completed' || t.status === 'failed')) break;
        await sleep(1500);
      }
      const p = await page.eval(`(() => ({
        items: document.querySelectorAll('.download-item').length,
        statuses: [...document.querySelectorAll('.download-item')].map(n => n.getAttribute('data-status')),
        text: document.querySelector('[data-route="downloads"]').textContent.replace(/\\s+/g,' ').slice(0, 140),
      }))()`);
      await shot(page, 'review-16-downloads');
      if (p.items === 0) throw new Error('无下载任务行');
      if (!done.some((t) => t.status === 'completed')) {
        throw new Error(`90s 内无任务完成：${JSON.stringify(done.map((t) => ({ s: t.status, e: t.errorCode, b: t.downloadedBytes })))}`);
      }
      const completed = done.find((t) => t.status === 'completed');
      if (!completed.blobKey) throw new Error('completed 任务缺 blobKey');
      return { ...p, completedBytes: completed.downloadedBytes, blobKey: completed.blobKey };
    });

    /* ===== 18. 设置页（重复渲染核查） ===== */
    await goto(page, '#/settings', 'settings');
    await sleep(1200);
    await step('E2E-18', '设置页行无重复渲染 + 概览计数', async () => {
      const p = await page.eval(`(() => {
        const rows = [...document.querySelectorAll('.settings-row')].map(n => n.querySelector('.settings-row__label')?.textContent?.trim() || '');
        return {
          rows: rows.length,
          labels: rows,
          dupes: [...new Set(rows.filter((v, i) => rows.indexOf(v) !== i))],
          overview: (document.querySelector('.overview__line')||{}).textContent?.trim() || null,
        };
      })()`);
      await shot(page, 'review-17-settings');
      if (p.dupes.length) throw new Error(`重复行: ${p.dupes.join(',')}`);
      if (!p.overview) throw new Error('缺少概览');
      return p;
    });

    /* ===== 19. 源管理 ===== */
    await goto(page, '#/settings/sources', 'sources');
    await sleep(1800);
    await step('E2E-19', '源管理仅 1 个内置演示源并显示健康状态', async () => {
      const p = await page.eval(`(() => ({
        cards: document.querySelectorAll('.source-card').length,
        flags: [...document.querySelectorAll('.source-card__flag')].map(n => n.textContent.trim()),
        health: [...document.querySelectorAll('[class*="health"]')].map(n => n.textContent.trim()).filter(Boolean).slice(0, 3),
        hasCompliance: /不提供任何片源/.test(document.body.textContent || ''),
      }))()`);
      await shot(page, 'review-18-sources');
      if (p.cards !== 1) throw new Error(`cards=${p.cards}`);
      if (!p.flags.includes('内置')) throw new Error('缺少「内置」角标');
      return p;
    });

    /* ===== 20. 新增源（AC-03/04/05） ===== */
    await goto(page, '#/settings/sources/new', 'source-form');
    await sleep(600);
    await step('E2E-20', '新增 AList 源可保存并出现在源列表（AC-03）', async () => {
      const before = await page.eval(IDB_COUNT('sources'));
      const filled = await page.eval(`(() => {
        const inputs = [...document.querySelectorAll('input, select, textarea')];
        return inputs.map(i => ({ type: i.type, name: i.name || i.id, ph: i.placeholder }));
      })()`);
      // 通过原生 setter 填名称与地址
      await page.eval(`(() => {
        const setV = (el, v) => {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const inputs = [...document.querySelectorAll('input')].filter(i => i.type !== 'file' && i.offsetParent !== null);
        if (inputs[0]) setV(inputs[0], '评审 AList');
        if (inputs[1]) setV(inputs[1], 'https://alist.example.com');
        return inputs.length;
      })()`);
      await sleep(500);
      const saved = await page.eval(CLICK('保存'));
      await sleep(2000);
      const after = await page.eval(IDB_COUNT('sources'));
      await shot(page, 'review-19-source-form');
      if (!saved) throw new Error('未找到保存按钮');
      if (after !== before + 1) throw new Error(`sources 表 ${before} → ${after}（期望 +1）；表单字段=${JSON.stringify(filled)}`);
      return { before, after };
    });

    /* ===== 21. 订阅导入（AC-08/13） ===== */
    await goto(page, '#/settings/sources/import', 'source-import');
    await step('E2E-21', '订阅链接解析并提交写入源（AC-08/13）', async () => {
      await page.eval(`(() => {
        const input = document.querySelector('#sub-url');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'http://127.0.0.1:${SUB_PORT}/sub.json');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(300);
      if (!(await page.eval(CLICK('获取')))) throw new Error('未找到获取按钮');
      await waitFor(page, `/共\\s*3\\s*个源/.test(document.body.textContent)`, 15000, 'import preview');
      await sleep(600);
      const preview = await page.eval(`document.querySelector('[data-route="source-import"]').textContent.replace(/\\s+/g,' ').slice(0, 200)`);
      await shot(page, 'review-20-import-preview');
      const before = await page.eval(IDB_COUNT('sources'));
      if (!(await page.eval(CLICK('导入')))) throw new Error('未找到导入按钮');
      await sleep(2500);
      const after = await page.eval(IDB_COUNT('sources'));
      const resultText = await page.eval(`document.body.textContent.replace(/\\s+/g,' ').slice(0, 400)`);
      await shot(page, 'review-21-import-result');
      if (/暂未开放|未写入/.test(resultText)) throw new Error(`导入未落库：${/暂未开放[^。]*/.exec(resultText)?.[0] ?? ''}`);
      if (after !== before + 2) throw new Error(`sources ${before} → ${after}（期望 +2，缺 api 的应跳过）`);
      return { preview: preview.slice(0, 100), before, after };
    });

    /* ===== 22. 备份导出 ===== */
    await goto(page, '#/settings/backup', 'backup');
    let backupPath = null;
    await step('E2E-22', '备份导出 JSON 且默认脱敏、含 schemaVersion', async () => {
      if (!(await page.eval(CLICK('导出备份文件')))) throw new Error('未找到导出按钮');
      await sleep(2500);
      const files = fs.readdirSync(DL_DIR).filter((f) => f.endsWith('.json'));
      if (!files.length) throw new Error(`下载目录无 JSON: ${fs.readdirSync(DL_DIR).join(',') || '(空)'}`);
      backupPath = path.join(DL_DIR, files[0]);
      const json = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
      await shot(page, 'review-22-backup');
      if (json.schemaVersion !== 1) throw new Error(`schemaVersion=${json.schemaVersion}`);
      if (!Array.isArray(json.sources)) throw new Error('缺少 sources');
      return { file: files[0], sources: json.sources.length, favorites: json.favorites?.length, history: json.history?.length, downloads: json.downloads?.length };
    });

    /* ===== 23. 备份导入 ===== */
    await step('E2E-23', '备份文件可解析预览并导入（AC-89）', async () => {
      if (!backupPath) throw new Error('无备份文件可导入');
      const doc = await page.send('DOM.getDocument', { depth: -1 });
      const node = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
      if (!node.nodeId) throw new Error('未找到文件输入');
      await page.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [backupPath] });
      await sleep(2000);
      const preview = await page.eval(`(() => ({
        text: document.querySelector('[data-route="backup"]').textContent.replace(/\\s+/g,' ').slice(0, 200),
        parsed: !!document.querySelector('.backup-preview'),
      }))()`);
      await shot(page, 'review-23-backup-import');
      if (!preview.parsed) throw new Error(`备份未解析：${preview.text}`);
      return preview;
    });

    /* ===== 24. 离线缓存 ===== */
    await goto(page, '#/library', 'library');
    await waitFor(page, `document.querySelectorAll('.poster-card').length >= 1`, 20000, 'library cached');
    await step('E2E-24', '离线时媒体库展示缓存并显示离线横幅', async () => {
      await page.send('Network.enable');
      await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      await page.eval(`location.hash = '#/downloads'`);
      await sleep(1200);
      await page.eval(`location.hash = '#/library'`);
      await sleep(2500);
      const p = await page.eval(`(() => ({
        cards: document.querySelectorAll('.poster-card').length,
        offline: !!document.querySelector('[class*="offline-banner"], [class*="offline"]'),
        text: document.body.textContent.replace(/\\s+/g,' ').slice(0, 100),
      }))()`);
      await shot(page, 'review-24-offline-library');
      await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      if (p.cards === 0) throw new Error('离线时无缓存海报');
      if (!p.offline) throw new Error('未显示离线横幅');
      return p;
    });

    /* ===== 25. 404 ===== */
    await step('E2E-25', '未知路由展示 404 页', async () => {
      await page.eval(`location.hash = '#/no-such-page'`);
      await sleep(1500);
      const text = await page.eval(`document.body.textContent.replace(/\\s+/g,' ').slice(0, 120)`);
      await shot(page, 'review-25-notfound');
      if (!/404|不存在|找不到/.test(text)) throw new Error(`无 404 文案: ${text}`);
      return text;
    });
  } catch (e) {
    record('E2E-FATAL', '脚本异常中断', false, e.message);
  } finally {
    const report = {
      base: BASE,
      ranAt: new Date().toISOString(),
      total: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
      consoleLogs: logs.slice(0, 60),
    };
    fs.writeFileSync(path.join(OUT, 'review-e2e-report.json'), JSON.stringify(report, null, 2));
    console.log(`\n=== ${report.passed}/${report.total} passed, ${report.failed} failed ===`);
    if (report.consoleLogs.length) console.log('console:', report.consoleLogs.slice(0, 20));
    try {
      chrome.kill();
    } catch {}
    subServer.close();
  }
})();
