/**
 * 补充验收脚本（BUG-02 编辑/测试连接/删除 + BUG-03 导入结果明细）
 * 仅读页面与 IndexedDB 做断言，产物写入 docs/03-设计规范/preview/
 * 用法：node scripts/review-supplement.cjs
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');

const BASE = process.env.BASE_URL || 'http://localhost:5175';
const OUT = path.resolve('docs/03-设计规范/preview');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9455;
const SUB_PORT = 8802;
const PROFILE = path.join(os.tmpdir(), `peanutmov-supp-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function record(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name} :: ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)}`);
}
async function step(id, name, fn) {
  try { record(id, name, true, (await fn()) ?? 'ok'); } catch (e) { record(id, name, false, e.message); }
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); } }, 40000);
    });
  }
  on(m, fn) { if (!this.listeners.has(m)) this.listeners.set(m, []); this.listeners.get(m).push(fn); }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.exceptionDetails) throw new Error(`eval failed: ${res.exceptionDetails.text}`);
    return res.result.value;
  }
}

const CLICK = (text) => `(() => {
  const want = ${JSON.stringify(text)};
  const hit = [...document.querySelectorAll('button, a, [role="button"]')]
    .find((n) => (n.textContent || '').replace(/\\s+/g, '').includes(want.replace(/\\s+/g, '')) && n.offsetParent !== null);
  if (!hit) return false; hit.click(); return true;
})()`;
const CLICK_ARIA = (label) => `(() => {
  const hit = [...document.querySelectorAll('[aria-label]')].find((n) => n.getAttribute('aria-label') === ${JSON.stringify(label)} && n.offsetParent !== null);
  if (!hit) return false; hit.click(); return true;
})()`;
const IDB_ALL = (store) => `new Promise((resolve) => {
  const req = indexedDB.open('cinema-db');
  req.onsuccess = () => { const all = req.result.transaction(${JSON.stringify(store)}, 'readonly').objectStore(${JSON.stringify(store)}).getAll();
    all.onsuccess = () => resolve(all.result); all.onerror = () => resolve([]); };
  req.onerror = () => resolve([]);
})`;

async function waitFor(page, expr, timeout = 15000, label = expr) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await page.eval(expr)) return true; await sleep(150); }
  throw new Error(`timeout waiting: ${label}`);
}
async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}
async function goto(page, hash, route, timeout = 20000) {
  await page.eval(`location.hash = ${JSON.stringify(hash)}`);
  await waitFor(page, `location.hash.startsWith(${JSON.stringify(hash)})`, 8000, `hash ${hash}`);
  await waitFor(page, `!!document.querySelector('[data-route="${route}"]')`, timeout, `view ${route}`);
  await sleep(700);
}

const SUBSCRIPTION = {
  name: '补充验收订阅',
  sources: [
    { key: 'supp-a', name: '补充 AList', type: 'alist', api: 'https://supp-alist.example.com' },
    { key: 'supp-b', name: '补充 WebDAV', type: 'webdav', api: 'https://supp-nas.example.com/dav' },
    { key: 'supp-bad', name: '补充缺字段', type: 'site' },
  ],
};

function startSubServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.url.startsWith('/sub.json')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(SUBSCRIPTION)); return; }
      res.writeHead(404); res.end('nf');
    });
    server.listen(SUB_PORT, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const subServer = await startSubServer();
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
    '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
  let page;
  try {
    for (let i = 0; i < 80; i += 1) { try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); } }
    const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const bws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r, j) => { bws.addEventListener('open', r, { once: true }); bws.addEventListener('error', j, { once: true }); });
    const browser = new Cdp(bws);
    const { browserContextId } = await browser.send('Target.createBrowserContext');
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const target = list.find((t) => t.id === targetId);
    const pws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { pws.addEventListener('open', r, { once: true }); pws.addEventListener('error', j, { once: true }); });
    page = new Cdp(pws);
    page.on('Runtime.exceptionThrown', (p) => console.log('[exception]', p.exceptionDetails?.exception?.description));
    await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('DOM.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

    await page.send('Page.navigate', { url: `${BASE}/#/welcome` });
    await waitFor(page, `!!document.querySelector('[data-route="welcome"]')`, 20000, 'welcome');
    await sleep(800);
    await page.eval(CLICK('我已阅读并同意'));
    await waitFor(page, `location.hash === '#/'`, 10000, 'home');
    await sleep(2000);

    /* ---- BUG-02: 新增（真实落库 + 跳转） ---- */
    await goto(page, '#/settings/sources/new', 'source-form');
    await step('SUP-01', '新增源保存后落库并 replace 到源列表', async () => {
      await page.eval(`(() => {
        const setV = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
        const inputs = [...document.querySelectorAll('input')].filter(i => i.offsetParent !== null);
        setV(inputs[0], '补充 AList');
        setV(inputs[1], 'https://supp-alist.example.com');
        return true;
      })()`);
      await sleep(400);
      if (!(await page.eval(CLICK('保存')))) throw new Error('未找到保存按钮');
      await waitFor(page, `location.hash === '#/settings/sources'`, 10000, 'back to sources');
      await sleep(1200);
      const rows = await page.eval(IDB_ALL('sources'));
      const hit = rows.find((s) => s.name === '补充 AList');
      if (!hit) throw new Error('sources 表无新增记录');
      await shot(page, 'review-26-source-saved');
      return { id: hit.id, name: hit.name, baseUrl: hit.baseUrl, key: hit.key };
    });

    /* ---- BUG-02: 测试连接（真实探测，失败不伪造成功） ---- */
    const createdId = await page.eval(`(async () => {
      const rows = await ${IDB_ALL('sources')};
      return (rows.find((s) => s.name === '补充 AList') || {}).id || null;
    })()`);
    await goto(page, `#/settings/sources/${createdId}/edit`, 'source-form');
    await step('SUP-02', '测试连接展示真实结果（不可达地址 → 失败，非"本地校验"）', async () => {
      await sleep(600);
      const label = await page.eval(`(() => {
        const b = [...document.querySelectorAll('button')].find(n => /测试连接/.test(n.textContent || ''));
        return b ? b.textContent.trim() : null;
      })()`);
      if (label === null) throw new Error('未找到测试连接按钮');
      await page.eval(CLICK('测试连接'));
      // DNS 失败可能耗时较久
      await waitFor(page, `!!document.querySelector('[class*="test-result"]')`, 40000, 'test result');
      const text = await page.eval(`document.querySelector('[class*="test-result"]').textContent.trim()`);
      await shot(page, 'review-27-source-test-connection');
      if (/本地校验/.test(text)) throw new Error(`仍是本地校验占位：${text}`);
      if (!/ms|失败|无法|超时|不可/.test(text)) throw new Error(`结果不可判定：${text}`);
      return { text, cls: await page.eval(`document.querySelector('[class*="test-result"]').className`) };
    });

    /* ---- BUG-02: 编辑保存 ---- */
    await step('SUP-03', '编辑源改名后落库并返回列表', async () => {
      await page.eval(`(() => {
        const el = document.querySelector('#source-name');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '补充 AList 改名');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(400);
      await page.eval(CLICK('保存'));
      await waitFor(page, `location.hash === '#/settings/sources'`, 10000, 'back after edit');
      await sleep(1200);
      const rows = await page.eval(IDB_ALL('sources'));
      const hit = rows.find((s) => s.name === '补充 AList 改名');
      if (!hit) throw new Error('改名未落库');
      return { name: hit.name, updatedAt: hit.updatedAt };
    });

    /* ---- BUG-02: 删除（ui.confirm 后真实删库） ---- */
    await goto(page, `#/settings/sources/${createdId}/edit`, 'source-form');
    await step('SUP-04', '删除源 → 确认后真实删除并返回列表', async () => {
      await sleep(800);
      if (!(await page.eval(CLICK('删除该源')))) throw new Error('未找到删除按钮');
      await waitFor(page, `!!document.querySelector('[role="alertdialog"]')`, 8000, 'confirm dialog');
      await shot(page, 'review-28-source-delete-confirm');
      // 只在对话框内点确认，避免命中页面里同为「删除该源」的按钮
      if (!(await page.eval(`(() => {
        const hit = [...document.querySelectorAll('[role="alertdialog"] .dialog__actions button')]
          .find((n) => /删除/.test(n.textContent || ''));
        if (!hit) return false; hit.click(); return true;
      })()`))) throw new Error('未找到确认删除按钮');
      await waitFor(page, `location.hash === '#/settings/sources'`, 10000, 'back after delete');
      await sleep(1500);
      const rows = await page.eval(IDB_ALL('sources'));
      if (rows.some((s) => s.id === createdId)) throw new Error('删除后 sources 表仍有该记录');
      await shot(page, 'review-29-source-deleted');
      return { remaining: rows.map((s) => s.name) };
    });

    /* ---- BUG-03: 导入结果明细 ---- */
    await goto(page, '#/settings/sources/import', 'source-import');
    await step('SUP-05', '订阅导入：成功 2 / 跳过 1，结果面板展示明细', async () => {
      await page.eval(`(() => {
        const input = document.querySelector('#sub-url');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'http://127.0.0.1:${SUB_PORT}/sub.json');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(300);
      await page.eval(CLICK('获取'));
      await waitFor(page, `/共\\s*3\\s*个源/.test(document.body.textContent)`, 15000, 'preview');
      await sleep(500);
      await shot(page, 'review-30-import-preview');
      const before = (await page.eval(IDB_ALL('sources'))).length;
      await page.eval(`document.querySelector('.import-commit').click()`);
      await waitFor(page, `!!document.querySelector('.import-result__card')`, 15000, 'result dialog');
      const text = await page.eval(`document.querySelector('.import-result__card').textContent.replace(/\\s+/g,' ').trim()`);
      await shot(page, 'review-31-import-result');
      const after = (await page.eval(IDB_ALL('sources'))).length;
      if (/暂未开放|未写入/.test(text)) throw new Error(`仍是占位：${text}`);
      // 结果面板必须同时体现「成功 2」与「跳过 1」（缺 api 的那条）
      if (!/成功\s*2/.test(text)) throw new Error(`结果不符：${text}`);
      if (!/跳过\s*1/.test(text)) throw new Error(`未体现跳过 1：${text}`);
      if (after !== before + 2) throw new Error(`sources ${before} → ${after}（期望 +2）`);
      return { text, before, after };
    });

    /* ---- BUG-03: 缺 api 条目跳过原因可见（在提交前的预览页） ---- */
    await step('SUP-06', '缺 api 条目在预览中给出跳过原因', async () => {
      await goto(page, '#/settings/sources/import', 'source-import');
      await page.eval(`(() => {
        const input = document.querySelector('#sub-url');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'http://127.0.0.1:${SUB_PORT}/sub.json');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(300);
      await page.eval(CLICK('获取'));
      await waitFor(page, `/共\\s*3\\s*个源/.test(document.body.textContent)`, 15000, 'preview');
      await sleep(500);
      const text = await page.eval(`document.querySelector('[data-route="source-import"]').textContent.replace(/\\s+/g,' ')`);
      await shot(page, 'review-33-import-skip-reason');
      if (!/缺少 api/.test(text)) throw new Error('未展示缺 api 原因');
      if (!/将跳过\s*1\s*个源/.test(text)) throw new Error(`未展示跳过块：${text.slice(-260)}`);
      return 'skip-section-ok';
    });

    /* ---- BUG-04: 单集电影直接创建（不走抽屉） ---- */
    await goto(page, '#/library', 'library');
    await waitFor(page, `document.querySelectorAll('.poster-card').length >= 12`, 20000, 'library');
    await step('SUP-07', '单集电影点下载直接建任务，不打开抽屉', async () => {
      await page.eval(`(() => {
        const card = [...document.querySelectorAll('.poster-card')].find(n => /Big Buck Bunny/.test(n.textContent || ''));
        card.click(); return true;
      })()`);
      await waitFor(page, `!!document.querySelector('.detail-hero__title')`, 20000, 'detail');
      await sleep(800);
      const label = await page.eval(`(() => {
        const b = [...document.querySelectorAll('[aria-label]')].find(n => n.getAttribute('aria-label') === '下载' || n.getAttribute('aria-label') === '选择集数下载');
        return b ? b.getAttribute('aria-label') : null;
      })()`);
      if (label !== '下载') throw new Error(`按钮 aria-label=${label}（单集应为「下载」）`);
      const before = (await page.eval(IDB_ALL('downloads'))).length;
      await page.eval(CLICK_ARIA('下载'));
      await sleep(3000);
      const sheet = await page.eval(`!!document.querySelector('[role="dialog"][aria-label*="下载"]')`);
      const after = (await page.eval(IDB_ALL('downloads'))).length;
      await shot(page, 'review-32-single-download');
      if (sheet) throw new Error('单集电影不应打开选集抽屉');
      if (after !== before + 1) throw new Error(`downloads ${before} → ${after}（期望 +1）`);
      return { label, before, after };
    });
  } catch (e) {
    record('SUP-FATAL', '脚本异常中断', false, e.message);
  } finally {
    const report = { base: BASE, ranAt: new Date().toISOString(), total: results.length,
      passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
    fs.writeFileSync(path.join(OUT, 'review-supplement-report.json'), JSON.stringify(report, null, 2));
    console.log(`\n=== ${report.passed}/${report.total} passed, ${report.failed} failed ===`);
    try { chrome.kill(); } catch {}
    subServer.close();
  }
})();
