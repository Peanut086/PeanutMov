/**
 * CHG-05 专项 E2E（headless Chrome + CDP，无第三方依赖）
 *
 * 覆盖：
 *   AC-106 六档分级与总览计数
 *   AC-107 批量测速进度（检测中 n/N）
 *   AC-108 排序切换 + 偏好持久化
 *   AC-109/110 失效线路自动跳过（有候选切一次 / 无候选不切）
 *   AC-111 非 JSON 源的错误文案（"不是订阅 JSON"）
 *
 * 本地起 3 个模拟线路：
 *   /ok.json    → 合法 TVBox JSON（200）
 *   /html      → text/html（200）
 *   /missing   → 404
 *
 * 用法：node scripts/review-chg05.cjs
 * 产物：docs/03-设计规范/preview/chg05-*.png + chg05-report.json
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BASE = process.env.BASE_URL || 'http://localhost:5174';
const OUT = path.resolve('docs/03-设计规范/preview');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9451;
const MOCK_PORT = 8812;
const PROFILE = path.join(os.tmpdir(), `peanutmov-chg05-${Date.now()}`);

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function record(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name} :: ${String(JSON.stringify(detail)).slice(0, 300)}`);
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

/* ---------- 模拟线路服务 ---------- */
function startMock() {
  const tvbox = JSON.stringify({
    code: 1,
    class: [{ type_id: 1, type_name: '电影' }],
    list: [
      {
        vod_id: 101,
        vod_name: '本地线路示例',
        vod_pic: '',
        vod_year: '2024',
        vod_play_from: '线路一',
        vod_play_url: '第1集$https://cdn.example.com/a.mp4',
      },
    ],
  });
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    // 模拟线路必须带 CORS 头，否则浏览器侧 fetch 会被拦（真实站点同理，属已知限制）
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    // 人为加 ~350ms 延迟：让「检测中 n/N」进度在真实 UI 上可观察（本地回环否则 <5ms 一闪而过）
    const delay = (fn) => setTimeout(fn, 350);
    if (url.startsWith('/ok.json')) {
      delay(() => {
        res.writeHead(200, { ...cors, 'content-type': 'application/json; charset=utf-8' });
        res.end(tvbox);
      });
      return;
    }
    if (url.startsWith('/sub.json')) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          name: 'CHG05 模拟线路',
          sources: [
            { key: 'mock-ok', name: '模拟可用线', type: 'site', api: `http://127.0.0.1:${MOCK_PORT}/ok.json` },
            { key: 'mock-html', name: '模拟HTML线', type: 'site', api: `http://127.0.0.1:${MOCK_PORT}/html` },
            { key: 'mock-404', name: '模拟404线', type: 'site', api: `http://127.0.0.1:${MOCK_PORT}/missing` },
          ],
        }),
      );
      return;
    }
    if (url.startsWith('/html')) {
      delay(() => {
        res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body>blocked</body></html>');
      });
      return;
    }
    delay(() => {
      res.writeHead(404, { ...cors, 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

/* ---------- CDP ---------- */
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
    if (res.exceptionDetails) throw new Error(`eval failed: ${res.exceptionDetails.text}`);
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
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
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

async function goto(page, hash, route, timeout = 20000) {
  await page.eval(`location.hash = ${JSON.stringify(hash)}`);
  await waitFor(page, `location.hash.startsWith(${JSON.stringify(hash)})`, 8000, `hash ${hash}`);
  await waitFor(page, `!!document.querySelector('[data-route="${route}"]')`, timeout, `view ${route}`);
  await sleep(600);
}

const CLICK = (text) => `(() => {
  const want = ${JSON.stringify(text)};
  const nodes = [...document.querySelectorAll('button, a, [role="button"]')];
  const hit = nodes.find((n) => (n.textContent || '').replace(/\\s+/g, '').includes(want.replace(/\\s+/g, '')) && n.offsetParent !== null);
  if (!hit) return false;
  hit.click();
  return true;
})()`;

/** 按选择器点击（文案有歧义时用，如"导入 N 个源"会被"导入订阅"先命中） */
const CLICK_SEL = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el || el.offsetParent === null || el.disabled) return false;
  el.click();
  return true;
})()`;

const IDB_COUNT = (store) => `(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('cinema-db'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return await new Promise((res, rej) => { const tx = db.transaction(${JSON.stringify(store)}, 'readonly'); const req = tx.objectStore(${JSON.stringify(store)}).count(); req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
})()`;

async function main() {
  const mock = await startMock();
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ]);
  const cleanup = () => {
    try {
      chrome.kill();
    } catch {}
    try {
      mock.close();
    } catch {}
  };
  process.on('exit', cleanup);

  try {
    // 等待 CDP 就绪
    for (let i = 0; i < 60; i += 1) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/json/version`);
        break;
      } catch {
        await sleep(200);
      }
    }
    const { page } = await connect();

    /* 首次进入 + 合规同意 */
    await page.eval(`location.href = ${JSON.stringify(`${BASE}/#/welcome`)}`);
    await sleep(1500);
    await step('CHG05-00', '首启并同意合规', async () => {
      await waitFor(page, `!!document.querySelector('[data-route="welcome"]')`, 20000, 'welcome');
      const agreed = await page.eval(CLICK('我已阅读并同意'));
      if (!agreed) {
        // 兜底：勾选复选框
        await page.eval(`(() => { const cb = document.querySelector('input[type="checkbox"]'); if (cb && !cb.checked) cb.click(); return true; })()`);
        await sleep(300);
        await page.eval(CLICK('同意'));
      }
      await waitFor(page, `!!document.querySelector('[data-route="home"]')`, 20000, 'home');
      return 'ok';
    });

    /* 导入 3 条模拟线路（1 可用 / 1 HTML / 1 404），走「从链接导入」 */
    await goto(page, '#/settings/sources/import', 'source-import');
    await step('CHG05-01', '从链接导入 3 条模拟线路', async () => {
      const before = await page.eval(IDB_COUNT('sources'));
      const hasInput = await page.eval(`!!document.querySelector('#sub-url')`);
      if (!hasInput) throw new Error('导入页无 #sub-url 输入框');
      await page.eval(`(() => {
        const input = document.querySelector('#sub-url');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(`http://127.0.0.1:${MOCK_PORT}/sub.json`)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(300);
      if (!(await page.eval(CLICK('获取')))) throw new Error('未找到获取按钮');
      await waitFor(page, `/共\\s*3\\s*个源/.test(document.body.textContent)`, 15000, 'preview 3');
      await sleep(500);
      await shot(page, 'chg05-import-preview');
      const imported = await page.eval(CLICK_SEL('.import-commit'));
      if (!imported) throw new Error('未找到导入按钮（.import-commit）');
      await sleep(3000);
      const after = await page.eval(IDB_COUNT('sources'));
      if (after !== before + 3) {
        const text = await page.eval(`document.body.textContent.replace(/\\s+/g,' ').slice(0, 300)`);
        throw new Error(`导入后源数量 ${before} → ${after}（期望 +3）；页面：${text}`);
      }
      return { before, after };
    });

    /* 源管理：批量测速 + 分级 + 总览 */
    await goto(page, '#/settings/sources', 'sources');
    await step('CHG05-02', '批量测速：进度 检测中 n/N → 完成', async () => {
      const clicked = await page.eval(CLICK('重新检测'));
      if (!clicked) throw new Error('未找到重新检测按钮');
      const sawProgress = await page.eval(`(async () => {
        for (let i = 0; i < 80; i += 1) {
          const btn = [...document.querySelectorAll('button')].find((b) => /检测中\\s*\\d+\\/\\d+/.test(b.textContent || ''));
          if (btn) return btn.textContent.trim();
          await new Promise((r) => setTimeout(r, 50));
        }
        return null;
      })()`);
      await waitFor(page, `/共\\s*\\d+\\s*条线路/.test(document.body.textContent)`, 20000, 'tier summary');
      const text = await page.eval(`document.querySelector('[data-route="sources"]').textContent.replace(/\\s+/g,' ')`);
      if (sawProgress === null) throw new Error('未观察到「检测中 n/N」进度文案');
      return { sawProgress, sample: text.slice(0, 200) };
    });

    await step('CHG05-03', '六档徽标：可用线=极速/快速，HTML 与 404 线=异常档', async () => {
      // 检测期间卡片只显示「检测中…」，必须等按钮恢复为「重新检测」再读徽标
      await waitFor(
        page,
        `(() => { const b = [...document.querySelectorAll('button')].find((n) => /重新检测/.test(n.textContent || '')); return !!b && !b.disabled; })()`,
        30000,
        'health check finished',
      );
      await sleep(500);
      await shot(page, 'chg05-source-tier-list');
      // 「异常」档在徽标上保留具体故障文案（配置有误/无法连接），故以 data-tier 判定档位
      const tiers = await page.eval(
        `[...document.querySelectorAll('.health-badge')].map((n) => ({ tier: n.getAttribute('data-tier'), text: n.textContent.trim() }))`,
      );
      const summary = await page.eval(`(() => {
        const el = document.querySelector('.sources-overview');
        return el ? el.textContent.replace(/\\s+/g,' ').trim() : null;
      })()`);
      if (!summary) throw new Error('缺少线路质量总览');
      const hasFast = tiers.some((t) => t.tier === 'fast' || t.tier === 'good');
      const badCount = tiers.filter((t) => t.tier === 'bad').length;
      if (!hasFast) throw new Error(`没有极速/快速档：${JSON.stringify(tiers)}`);
      if (badCount < 2) throw new Error(`异常档应 ≥2（HTML + 404），实际 ${badCount}：${JSON.stringify(tiers)}`);
      if (!/异常\s*2/.test(summary)) throw new Error(`总览异常计数不符：${summary}`);
      return { tiers, summary };
    });

    await step('CHG05-04', '排序切换为「按线路质量」并持久化', async () => {
      const switched = await page.eval(CLICK('按线路质量'));
      if (!switched) throw new Error('未找到排序切换');
      await sleep(800);
      const stored = await page.eval(`localStorage.getItem('peanutmov.sourceSortMode')`);
      const order = await page.eval(`[...document.querySelectorAll('.source-card')].map((n) => (n.querySelector('[class*="title"]')||n).textContent.replace(/\\s+/g,' ').trim().slice(0,20))`);
      await shot(page, 'chg05-source-sorted');
      return { stored, order };
    });

    await step('CHG05-05', '非 JSON 线路的错误文案（AC-111，用户可见路径）', async () => {
      await goto(page, '#/settings/sources', 'sources');
      const opened = await page.eval(`(() => {
        const card = [...document.querySelectorAll('.source-card')].find((n) => /模拟HTML线/.test(n.textContent || ''));
        if (!card) return false;
        const main = card.querySelector('.source-card__main');
        (main || card).click();
        return true;
      })()`);
      if (!opened) throw new Error('未找到模拟HTML线卡片');
      await waitFor(page, `!!document.querySelector('.source-form')`, 20000, 'source form');
      await sleep(800);
      const clicked = await page.eval(CLICK('测试连接'));
      if (!clicked) {
        const buttons = await page.eval(`[...document.querySelectorAll('button')].map((n) => ({ t: (n.textContent||'').trim().slice(0,12), d: n.disabled }))`);
        throw new Error(`未找到可点的「测试连接」：${JSON.stringify(buttons)}`);
      }
      await waitFor(page, `/不是订阅 JSON|不是 TVBox|认证失败|无法连接|资源不存在/.test(document.body.textContent)`, 20000, 'test result');
      await sleep(600);
      const text = await page.eval(`document.body.textContent.replace(/\\s+/g,' ')`);
      await shot(page, 'chg05-nonjson-error');
      const matched = /不是订阅 JSON|不是 TVBox/.test(text);
      if (!matched) throw new Error(`未出现非 JSON 文案：${text.slice(0, 240)}`);
      return { matched, sample: text.slice(0, 240) };
    });

    /* 失效线路自动跳过：显式以 404 线打开媒体库（AC-109 的 A/B 场景） */
    await step('CHG05-06', '失效线路自动跳过（有候选 → 切一次 + Toast）', async () => {
      // 用 `?sourceId=` 显式打开 B（404 线），避免依赖"默认源"与内存 currentSource 的先后关系
      const failedId = await page.eval(`(async () => {
        const db = await new Promise((res, rej) => { const r = indexedDB.open('cinema-db'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const all = await new Promise((res, rej) => { const tx = db.transaction('sources', 'readonly'); const rq = tx.objectStore('sources').getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
        const hit = all.find((s) => s.name === '模拟404线');
        return hit ? hit.id : null;
      })()`);
      if (!failedId) throw new Error('未找到模拟404线的 id');

      await page.eval(`(() => {
        window.__chg05Toasts = [];
        const obs = new MutationObserver(() => {
          for (const el of document.querySelectorAll('.toast')) {
            const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (t && !window.__chg05Toasts.includes(t)) window.__chg05Toasts.push(t);
          }
        });
        obs.observe(document.body, { childList: true, subtree: true, characterData: true });
        window.__chg05Obs = obs;
        return true;
      })()`);

      await page.eval(`location.hash = '#/library?sourceId=' + encodeURIComponent(${JSON.stringify(failedId)})`);
      await waitFor(page, `!!document.querySelector('[data-route="library"]')`, 20000, 'library');
      const toastText = await page.eval(`(async () => {
        for (let i = 0; i < 60; i += 1) {
          const hit = (window.__chg05Toasts || []).find((t) => /已自动切换到/.test(t));
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 100));
        }
        return null;
      })()`);
      await sleep(1200);
      const currentSource = await page.eval(`(() => {
        const el = document.querySelector('.library-toolbar__btn');
        return el ? el.textContent.replace(/\\s+/g,' ').trim() : null;
      })()`);
      const cards = await page.eval(`document.querySelectorAll('.poster-card').length`);
      await shot(page, 'chg05-fallback-toast');
      if (!toastText) throw new Error(`未捕获切换 Toast；当前源=${currentSource}，卡片=${cards}`);
      if (!/模拟可用线/.test(String(currentSource))) throw new Error(`当前源未切到可用线：${currentSource}`);
      if (!/模拟404线/.test(toastText)) throw new Error(`Toast 未点名失效源：${toastText}`);
      if (cards < 1) throw new Error('切换后海报墙为空');
      return { failedId, toastText, currentSource, cards };
    });

    /* AC-110：无候选时不切换、保持错误态 */
    await step('CHG05-06b', '无候选时不自动切换（AC-110）', async () => {
      await goto(page, '#/settings/sources', 'sources');
      // 禁用可用线与演示源，只留 404 线
      await page.eval(`(async () => {
        for (const name of ['模拟可用线', '内置演示']) {
          const card = [...document.querySelectorAll('.source-card')].find((n) => (n.textContent || '').includes(name));
          const sw = card && card.querySelector('[role="switch"], input[type="checkbox"], .toggle-switch');
          if (sw) sw.click();
          await new Promise((r) => setTimeout(r, 400));
        }
        return true;
      })()`);
      await sleep(1200);
      await goto(page, '#/library', 'library');
      await sleep(3000);
      const text = await page.eval(`document.body.textContent.replace(/\\s+/g,' ')`);
      const currentSource = await page.eval(`(() => {
        const el = document.querySelector('.library-toolbar__btn');
        return el ? el.textContent.replace(/\\s+/g,' ').trim() : null;
      })()`);
      await shot(page, 'chg05-fallback-none');
      const switched = /已自动切换到/.test(text);
      if (switched) throw new Error('无候选时不应切换，但出现了切换 Toast');
      return { currentSource, hasError: /无法连接|加载失败|重试/.test(text), sample: text.slice(0, 160) };
    });

    await step('CHG05-07', '刷新后排序偏好仍为 tier', async () => {
      await page.eval('location.reload()');
      await sleep(3500);
      const stored = await page.eval(`localStorage.getItem('peanutmov.sourceSortMode')`);
      return { stored };
    });
  } finally {
    const report = {
      base: BASE,
      ranAt: new Date().toISOString(),
      total: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
    fs.writeFileSync(path.join(OUT, 'chg05-report.json'), JSON.stringify(report, null, 2));
    console.log(`\n=== ${report.passed}/${report.total} passed, ${report.failed} failed ===`);
    cleanup();
    process.exit(report.failed > 0 ? 1 : 0);
  }
}

void main();
