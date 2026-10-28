/**
 * 真机全流程抽样探测器（WebView CDP + Pinia/路由驱动）
 *
 * 用法：
 *   node scripts/real-device-probe.cjs list                     列出源分布
 *   node scripts/real-device-probe.cjs eval "<js>"              在页面里执行表达式
 *   node scripts/real-device-probe.cjs shot <file.png>          截图
 *   node scripts/real-device-probe.cjs sample [n] [seed]        随机抽源跑「库→分类→详情→播放→搜索」
 *   node scripts/real-device-probe.cjs global                   跑全局流程（首页/聚合搜索/直播/历史/收藏/下载）
 *
 * 输出：docs/05-测试报告/evidence/real-device-<date>/<cmd>-<ts>.json
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PORT = Number(process.env.WV_PORT || 9333);
const OUT_DIR =
  process.env.OUT_DIR ||
  path.join('docs', '05-测试报告', 'evidence', `real-device-${new Date().toISOString().slice(0, 10)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(cmd) {
  const parts = cmd.split(/\s+/);
  try {
    return execFileSync('adb', parts, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    // pidof 找不到进程时退出码为 1：对调用方而言就是「空结果」
    if (e.status === 1) return '';
    throw e;
  }
}

function devicePid() {
  const out = adb('shell pidof com.qoder.cinema');
  if (!out) throw new Error('App 未运行：先 adb shell am start -n com.qoder.cinema/.MainActivity');
  return out.split(/\s+/)[0];
}

function ensureForward() {
  const pid = devicePid();
  adb('forward --remove-all');
  adb(`forward tcp:${PORT} localabstract:webview_devtools_remote_${pid}`);
  return pid;
}

/** 页面内注入的测试助手（挂在 window.__T） */
const PAGE_HELPERS = `
window.__T = window.__T || (() => {
  const app = () => document.querySelector('#app').__vue_app__;
  const pinia = () => app().config.globalProperties.$pinia;
  const store = (n) => pinia()._s.get(n);
  const router = () => app().config.globalProperties.$router;
  const withTimeout = (p, ms, label) => Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT:' + (label || 'op') + ':' + ms)), ms)),
  ]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms, step = 400) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { const v = fn(); if (v) return v; } catch (e) { /* ignore */ }
      await sleep(step);
    }
    return null;
  };
  const errShape = (e) => e && ({ code: e.code || e.name || 'E_UNKNOWN', message: String(e.message || e) });
  return { app, pinia, store, router, withTimeout, sleep, waitFor, errShape };
})();
'ok'
`;

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function connect() {
  ensureForward();
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((p) => p.type === 'page' && p.url.includes('localhost'));
  if (!page) throw new Error('未找到 WebView 页面: ' + JSON.stringify(list));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const pend = new Map();
  const logs = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
        .join(' ');
      logs.push({ level: m.params.type, text });
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push({ level: 'exception', text: (d.exception && d.exception.description) || d.text });
    }
  });
  /** CDP 调用：断线或超时都 reject（页面被系统杀掉后 pending 永不返回，必须兜底） */
  const send = (method, params = {}, timeoutMs = 15000) =>
    new Promise((res, rej) => {
      if (ws.readyState !== 1) {
        rej(new Error('CDP_DISCONNECTED'));
        return;
      }
      const i = ++id;
      const timer = setTimeout(() => {
        pend.delete(i);
        rej(new Error('CDP_TIMEOUT: ' + method));
      }, timeoutMs);
      pend.set(i, (msg) => {
        clearTimeout(timer);
        res(msg);
      });
      try {
        ws.send(JSON.stringify({ id: i, method, params }));
      } catch (e) {
        clearTimeout(timer);
        pend.delete(i);
        rej(new Error('CDP_SEND_FAILED: ' + e.message));
      }
    });

  ws.addEventListener('close', () => {
    for (const [, fn] of pend) fn({ error: { message: 'CDP_CLOSED' } });
    pend.clear();
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');

  const ev = async (expr, timeoutMs = 240000) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    }, timeoutMs);
    if (r.error) throw new Error('CDP_ERR: ' + r.error.message);
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error('PAGE_EXC: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const evJson = async (expr) => {
    const v = await ev(`(async()=>{ ${PAGE_HELPERS}; const T = window.__T; ${expr} })()`);
    return typeof v === 'string' ? JSON.parse(v) : v;
  };
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  };
  return { ws, send, ev, evJson, shot, logs };
}

function save(cmd, data) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${cmd}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/* ---------------- 单个源的全流程 ---------------- */

const PROBE_SOURCE = `
const lib = T.store('library'); const src = T.store('source'); const out = { steps: {} };
const byId = (id) => src.sources.find(s => s.id === id) || null;

// 1) 浏览：真实走 library.openSource（UI 切源走的同一条路径）
{
  const t0 = Date.now();
  try {
    await T.withTimeout(lib.openSource(sourceId), 90000, 'browse');
    out.steps.browse = {
      ok: lib.state === 'success',
      state: lib.state,
      ms: Date.now() - t0,
      items: lib.items.length,
      categories: lib.categories.map(c => c.name).slice(0, 12),
      hasMore: lib.hasMore,
      error: T.errShape(lib.error),
    };
  } catch (e) {
    out.steps.browse = { ok: false, state: lib.state, ms: Date.now() - t0, error: T.errShape(e) };
  }
}

// 2) 分类：切到第一个真实分类（若有）
{
  const first = lib.categories[0];
  if (!first) { out.steps.category = { skipped: 'no-categories' }; }
  else {
    const t0 = Date.now();
    try {
      await T.withTimeout(lib.setCategory(first.id), 60000, 'category');
      out.steps.category = {
        ok: lib.state === 'success', name: first.name, state: lib.state,
        ms: Date.now() - t0, items: lib.items.length, error: T.errShape(lib.error),
      };
      await T.withTimeout(lib.setCategory(null), 60000, 'category-back').catch(() => {});
    } catch (e) {
      out.steps.category = { ok: false, name: first.name, ms: Date.now() - t0, error: T.errShape(e) };
    }
  }
}

// 3) 详情：取浏览列表里第一个非演示条目
{
  const item = lib.items.find(i => !i.isDemo) || null;
  if (!item) { out.steps.detail = { skipped: 'no-items' }; }
  else {
    const t0 = Date.now();
    try {
      await T.withTimeout(lib.loadDetail(item.id, true), 60000, 'detail');
      const d = lib.detail;
      out.steps.detail = {
        ok: lib.detailState === 'success' && !!d,
        state: lib.detailState, ms: Date.now() - t0,
        title: d && d.item.title,
        lines: d ? d.lines.map(l => ({ name: l.name, format: l.format })) : [],
        episodes: d ? d.episodes.length : 0,
        error: T.errShape(lib.error),
      };
    } catch (e) {
      out.steps.detail = { ok: false, state: lib.detailState, ms: Date.now() - t0, error: T.errShape(e) };
    }
  }
}

// 4) 播放解析：真实调 resolvePlay（播放页加载播放地址的同一条路径）
{
  const d = lib.detail;
  const line = d && d.lines[0];
  const ep = d && d.episodes.find(e => !line || e.lineId === line.id);
  if (!d || !line || !ep) { out.steps.resolve = { skipped: 'no-line-or-episode' }; }
  else {
    const t0 = Date.now();
    try {
      const ps = await T.withTimeout(lib.resolvePlay(d.item.id, ep.id, line.id), 60000, 'resolve');
      out.steps.resolve = {
        ok: !!ps.url, ms: Date.now() - t0,
        format: ps.format, isLocal: ps.isLocal, isLive: !!ps.isLive,
        urlScheme: String(ps.url).split(':')[0],
        urlHost: (() => { try { return new URL(ps.url).host; } catch (e) { return '-'; } })(),
        headers: Object.keys(ps.headers || {}),
        subtitles: (ps.subtitles || []).length,
        expiresAt: ps.expiresAt,
      };
      out.playTarget = { mediaId: d.item.id, episodeId: ep.id, lineId: line.id };
    } catch (e) {
      out.steps.resolve = { ok: false, ms: Date.now() - t0, error: T.errShape(e) };
    }
  }
}

// 5) 搜索：限定到本源，关键词取浏览列表首条标题的一段（应当能命中）
{
  const item = lib.items.find(i => !i.isDemo);
  const kw = item ? String(item.title).replace(/\\s+/g, '').slice(0, 4) : '测试';
  const t0 = Date.now();
  try {
    lib.setSearchScope('selected', [sourceId]);
    await T.withTimeout(lib.search(kw), 90000, 'search');
    out.steps.search = {
      ok: lib.searchState === 'success', keyword: kw, state: lib.searchState,
      ms: Date.now() - t0, results: lib.searchResults.length, all: lib.searchResultsAll.length,
      candidates: lib.searchCandidates, filteredOut: lib.searchFilteredOut,
      failed: lib.searchFailed.map(f => ({ sourceId: f.sourceId, code: f.error && f.error.code, message: f.error && f.error.message })),
      error: T.errShape(lib.error),
    };
    lib.clearSearch();
    lib.setSearchScope('all');
  } catch (e) {
    out.steps.search = { ok: false, keyword: kw, ms: Date.now() - t0, error: T.errShape(e) };
    lib.setSearchScope('all');
  }
}

const s = byId(sourceId);
out.source = s && { id: s.id, name: s.name, type: s.type, kind: s.ext && s.ext.kind, health: s.health, baseUrl: s.baseUrl, subscriptionId: s.subscriptionId, warning: s.warning };
return JSON.stringify(out);
`;

/* ---------------- 播放页验证 ---------------- */

const PROBE_PLAYER = `
const lib = T.store('library');
const target = JSON.parse(JSON.stringify(window.__playTarget || null));
if (!target) return JSON.stringify({ skipped: 'no-target' });
const q = { lineId: target.lineId };
await T.router().push({ name: 'player', params: { mediaId: target.mediaId, episodeId: target.episodeId }, query: q });
const p = T.store('player');
const ready = await T.waitFor(() => (p.loading === false && (p.duration > 0 || p.error)) || p.error, 60000);
await T.sleep(2500);
const state = {
  loading: p.loading, engineKind: p.engineKind, error: p.error ? { code: p.error.code, message: p.error.message } : null,
  duration: Math.round(p.duration), currentTime: Math.round(p.currentTime * 100) / 100,
  playing: p.playing, waiting: p.waiting, qualities: p.qualities, subtitles: p.subtitles.length,
  mediaId: p.mediaId, lineId: p.lineId,
};
const video = document.querySelector('video');
const vstate = video ? { readyState: video.readyState, networkState: video.networkState, paused: video.paused, currentSrc: String(video.currentSrc).slice(0, 120), errorCode: video.error ? video.error.code : null, videoWidth: video.videoWidth, videoHeight: video.videoHeight } : null;
if (ready === null) state.timedOut = true;
return JSON.stringify({ state, vstate, ready: !!ready });
`;

/** 崩溃自愈：确保 App 在前台并返回可用的 CDP 会话 */
async function ensureSession(ctxRef) {
  const alive = (() => {
    try {
      return adb('shell pidof com.qoder.cinema') !== '';
    } catch {
      return false;
    }
  })();
  if (alive && ctxRef.cur && ctxRef.cur.ws.readyState === 1) return { restarted: false, ctx: ctxRef.cur };
  if (!alive) {
    adb('shell am start -n com.qoder.cinema/.MainActivity');
    await sleep(9000);
  }
  const next = await connect();
  ctxRef.cur = next;
  await sleep(1500);
  return { restarted: true, ctx: next };
}

async function listSources(ctx) {
  return ctx.evJson(`
    const db = await new Promise((res) => { const r = indexedDB.open('cinema-db', 3); r.onsuccess = () => res(r.result); });
    const all = await new Promise((res) => { const q = db.transaction('sources').objectStore('sources').getAll(); q.onsuccess = () => res(q.result); });
    const cur = T.store('source').currentSourceId;
    return JSON.stringify({ total: all.length, currentSourceId: cur, sources: all.map(s => ({ id: s.id, name: s.name, type: s.type, kind: (s.ext && s.ext.kind) || null, health: s.health, enabled: s.enabled, baseUrl: s.baseUrl })) });
  `);
}

/** 随机抽源（固定种子可复现）：2/3 健康源 + 1/3 异常源，尽量覆盖 jar/js/site */
function pickSources(meta, n, seed) {
  const all = meta.sources.filter((s) => s.type !== 'demo');
  const rand = mulberry32(seed);
  const okPool = all.filter((s) => s.health === 'ok');
  const badPool = all.filter((s) => s.health !== 'ok');
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  // 2/3 抽健康源验证主链路，1/3 抽异常源验证失败路径；尽量覆盖 jar/js/site 三类
  const nOk = Math.max(1, Math.round((n * 2) / 3));
  const okPick = [];
  for (const kind of ['jar', 'js', null]) {
    const cand = shuffle(okPool.filter((s) => s.kind === kind && !okPick.includes(s)));
    if (cand[0] && okPick.length < nOk) okPick.push(cand[0]);
  }
  for (const s of shuffle(okPool)) {
    if (okPick.length >= nOk) break;
    if (!okPick.includes(s)) okPick.push(s);
  }
  const badPick = shuffle(badPool).slice(0, Math.max(0, n - okPick.length));
  return { all, okPool, badPool, picked: [...okPick, ...badPick] };
}

async function runSample(ctxRef, n, seed) {
  const meta = await listSources(ctxRef.cur);
  const { all, okPool, badPool, picked } = pickSources(meta, n, seed);

  const results = [];
  const session = { restarts: 0, crashes: [] };
  let logCursor = Date.now();
  for (const s of picked) {
    process.stderr.write(`\n[${results.length + 1}/${picked.length}] ${s.name} (${s.type}/${s.kind || '-'}, health=${s.health})\n`);
    // 上一条 probe 可能把 App 弄崩（原生插件异常会直接杀进程），先确保会话可用
    const healthy = await ensureSession(ctxRef);
    if (healthy.restarted) {
      session.restarts += 1;
      session.crashes.push({ after: results.at(-1)?.source?.name ?? null, at: new Date().toISOString() });
      process.stderr.write('    ⚠ App 进程已重启，继续\n');
    }
    const live = ctxRef.cur;
    const t0 = Date.now();
    let probe = null;
    try {
      probe = await live.evJson(`const sourceId = ${JSON.stringify(s.id)}; ${PROBE_SOURCE}`);
    } catch (e) {
      probe = { source: s, steps: { fatal: String(e.message).slice(0, 800) } };
    }
    probe.ms = Date.now() - t0;

    if (probe.playTarget) {
      try {
        await live.evJson(`window.__playTarget = ${JSON.stringify(probe.playTarget)}; 'ok'`);
        probe.player = await live.evJson(PROBE_PLAYER);
      } catch (e) {
        probe.player = { fatal: String(e.message).slice(0, 800) };
      }
      try {
        await live.evJson(`window.__playTarget = null; await T.router().push({ name: 'home' }).catch(()=>{}); T.sleep(300); 'ok'`);
      } catch {
        /* 播放页崩溃后连接已断，交给下一轮 ensureSession */
      }
    }
    results.push(probe);
    process.stderr.write(
      `    browse=${probe.steps.browse ? probe.steps.browse.state + '/' + (probe.steps.browse.items ?? '-') : '?'}` +
        ` detail=${probe.steps.detail ? probe.steps.detail.state + '/' + (probe.steps.detail.episodes ?? '-') : '?'}` +
        ` resolve=${probe.steps.resolve ? (probe.steps.resolve.ok ? 'OK' : (probe.steps.resolve.error ? probe.steps.resolve.error.code : probe.steps.resolve.skipped)) : '?'}` +
        ` search=${probe.steps.search ? (probe.steps.search.results ?? '-') : '?'}` +
        ` player=${probe.player ? (probe.player.state ? (probe.player.state.duration + 's/' + probe.player.state.engineKind) : probe.player.skipped) : '-'}\n`,
    );
    // 增量落盘：中途崩溃也不会丢已完成的结果
    save('sample', { seed, total: all.length, okPool: okPool.length, badPool: badPool.length, session, results, partial: results.length < picked.length });
  }
  const crashLog = (() => {
    try {
      return execFileSync('adb', ['logcat', '-d', '-t', '4000'], { encoding: 'utf8' })
        .split('\n')
        .filter((l) => /FATAL EXCEPTION|has died:|CAPACITOR_PLUGIN|IllegalStateException|OutOfMemoryError/.test(l))
        .slice(-40);
    } catch {
      return [];
    }
  })();
  return {
    seed,
    pickedAt: new Date().toISOString(),
    total: all.length,
    okPool: okPool.length,
    badPool: badPool.length,
    session,
    crashLog,
    results,
  };
}

/* ---------------- 全局流程 ---------------- */

const GLOBAL_FLOW = `
const out = { steps: {} };
const lib = T.store('library');
const hist = T.store('history');
const fav = T.store('favorite');
const srcStore = T.store('source');
const dl = T.store('download');

// A. 首页
{
  const t0 = Date.now();
  await T.router().push({ name: 'home' });
  await T.sleep(500);
  try {
    await T.withTimeout(lib.loadHome(), 60000, 'home');
    out.steps.home = { state: lib.homeState, ms: Date.now() - t0, recent: lib.homeRecent.length,
      currentSource: srcStore.currentSource && srcStore.currentSource.name,
      error: T.errShape(lib.homeError) };
  } catch (e) { out.steps.home = { state: lib.homeState, error: T.errShape(e) }; }
}

// B. 聚合搜索（全部范围）：走搜索页真实链路（路由带 q → 页面 onMounted 自行发起）
{
  const t0 = Date.now();
  await T.router().push({ name: 'search', query: { q: '斗罗' } });
  // 等页面自身的搜索跑完（loading → 终态）；页面会先 await sources.load()
  const settled = await T.waitFor(
    () => lib.searchKeyword === '斗罗' && (lib.searchState === 'success' || lib.searchState === 'empty' || lib.searchState === 'error'),
    180000,
    500,
  );
  out.steps.searchAll = {
    state: lib.searchState,
    settled: !!settled,
    ms: Date.now() - t0,
    results: lib.searchResults.length,
    all: lib.searchResultsAll.length,
    groups: lib.searchGroups.length,
    candidates: lib.searchCandidates,
    filteredOut: lib.searchFilteredOut,
    failed: lib.searchFailed.length,
    failedByCode: lib.searchFailed.reduce((m, f) => {
      const c = (f.error && f.error.code) || 'E_UNKNOWN';
      m[c] = (m[c] || 0) + 1;
      return m;
    }, {}),
    failedBySource: lib.searchFailed.map((f) => {
      const s = srcStore.sources.find((x) => x.id === f.sourceId);
      return { name: s && s.name, kind: s && s.ext && s.ext.kind, code: f.error && f.error.code, msg: String((f.error && f.error.message) || '').slice(0, 160) };
    }),
    error: T.errShape(lib.error),
  };
}

// C. 直播页
{
  const t0 = Date.now();
  try {
    await T.router().push({ name: 'live' });
    await T.sleep(3000);
    const lv = T.store('ui');
    out.steps.live = { ms: Date.now() - t0, hash: location.hash };
  } catch (e) { out.steps.live = { error: T.errShape(e) }; }
}

// D. 收藏 / 历史页可达性 + 数据量
{
  await T.router().push({ name: 'history' });
  await T.sleep(2000);
  out.steps.history = { hash: location.hash, records: hist.records ? hist.records.length : null };
  await T.router().push({ name: 'favorites' });
  await T.sleep(2000);
  out.steps.favorites = { hash: location.hash, records: fav.records ? fav.records.length : null };
}

// E. 订阅管理 / 源管理页可达性
{
  await T.router().push({ name: 'subscriptions' });
  await T.sleep(2500);
  out.steps.subscriptions = { hash: location.hash, summaries: (srcStore.subscriptionSummaries || []).length };
  await T.router().push({ name: 'sources' });
  await T.sleep(2500);
  out.steps.sources = { hash: location.hash, count: srcStore.sources.length };
}

await T.router().push({ name: 'home' });
return JSON.stringify(out);
`;

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  const ctx = await connect();
  const ctxRef = { cur: ctx };
  try {
    switch (cmd) {
      case 'eval': {
        console.log(await ctx.ev(args.join(' ')));
        break;
      }
      case 'evaljson': {
        console.log(JSON.stringify(await ctx.evJson(args.join(' ')), null, 2));
        break;
      }
      case 'shot': {
        console.log('saved', await ctx.shot(path.join(OUT_DIR, args[0] || 'shot.png')));
        break;
      }
      case 'list': {
        const data = await ctx.evJson(`
          const db = await new Promise((res) => { const r = indexedDB.open('cinema-db', 3); r.onsuccess = () => res(r.result); });
          const all = await new Promise((res) => { const q = db.transaction('sources').objectStore('sources').getAll(); q.onsuccess = () => res(q.result); });
          return JSON.stringify(all.map(s => ({ name: s.name, type: s.type, kind: (s.ext && s.ext.kind) || null, health: s.health, enabled: s.enabled, autoDisabledAt: !!s.autoDisabledAt })));
        `);
        const agg = {};
        for (const s of data) {
          const k = `${s.type}/${s.kind || '-'}/${s.health}${s.autoDisabledAt ? '/autoDisabled' : ''}`;
          agg[k] = (agg[k] || 0) + 1;
        }
        console.log(JSON.stringify(agg, null, 2));
        console.log('saved', save('list', { agg, data }));
        break;
      }
      case 'pick': {
        const n = Number(args[0] || 8);
        const seed = Number(args[1] || 20261027);
        const meta = await listSources(ctxRef.cur);
        const { all, okPool, badPool, picked } = pickSources(meta, n, seed);
        const data = { seed, total: all.length, okPool: okPool.length, badPool: badPool.length, picked };
        console.log(picked.map((s) => `${s.name} | ${s.type}/${s.kind || '-'} | ${s.health} | ${s.id}`).join('\n'));
        console.log('saved', save('pick', data));
        break;
      }
      case 'one': {
        // 单源跑一遍五步链路；崩溃只会影响本进程，由外部逐条重试
        const id = args[0];
        if (!id) throw new Error('one 需要 sourceId');
        const before = await ensureSession(ctxRef);
        const live = ctxRef.cur;
        const t0 = Date.now();
        const probe = await live.evJson(`const sourceId = ${JSON.stringify(id)}; ${PROBE_SOURCE}`);
        probe.ms = Date.now() - t0;
        probe.restartedBefore = before.restarted;
        if (probe.playTarget) {
          await live.evJson(`window.__playTarget = ${JSON.stringify(probe.playTarget)}; 'ok'`);
          try {
            probe.player = await live.evJson(PROBE_PLAYER);
          } catch (e) {
            probe.player = { fatal: String(e.message).slice(0, 600) };
          }
        }
        probe.console = live.logs.slice(-120);
        console.log('saved', save('one', probe));
        break;
      }
      case 'sample': {
        const n = Number(args[0] || 6);
        const seed = Number(args[1] || 20261027);
        const data = await runSample(ctxRef, n, seed);
        data.console = ctxRef.cur.logs.slice(-200);
        console.log('saved', save('sample', data));
        break;
      }
      case 'global': {
        const data = await ctx.evJson(GLOBAL_FLOW);
        data.console = ctx.logs.slice(-200);
        console.log(JSON.stringify(data.steps, null, 2));
        console.log('saved', save('global', data));
        break;
      }
      default:
        console.log('命令：list | eval <js> | evaljson <js> | shot <file> | sample [n] [seed] | global');
    }
  } finally {
    try {
      ctxRef.cur.ws.close();
    } catch {
      /* 已断开的连接无需关闭 */
    }
    if (ctxRef.cur !== ctx) {
      try {
        ctx.ws.close();
      } catch {
        /* ignore */
      }
    }
  }
})();
