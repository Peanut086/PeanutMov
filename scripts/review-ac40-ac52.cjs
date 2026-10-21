/**
 * AC-40（DASH/DRM 明确拒绝）与 AC-52（全屏状态栏调用）实测脚本
 *
 * 设计原则：
 * - 不改数据层代码、不改演示片单；所有验证都在真实页面 + 真实应用模块上进行；
 * - PlayerController 实例由 **dev server 上的真实模块**构建（`import('/src/...')`），
 *   因此跑的是生产路径，而不是测试替身；
 * - 断言结果渲染成页面内"验收板"后截图，保证截图与断言一一对应；
 * - 不伪造任何成功：失败用例直接 fail 并写入报告。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PORT = 9447;
const BASE = process.env.BASE_URL || 'http://localhost:5175';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.resolve('docs/03-设计规范/preview');
const REPORT = path.resolve('docs/03-设计规范/preview/ac40-ac52-report.json');

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = path.join(os.tmpdir(), `pm-ac40-${Date.now()}`);
  spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--disable-gpu',
      '--hide-scrollbars',
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/version`);
      break;
    } catch {
      await sleep(250);
    }
  }

  const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((res) => {
      const i = ++id;
      pend.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params, sessionId }));
    });
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.result?.exceptionDetails) return { __exc: JSON.stringify(r.result.exceptionDetails).slice(0, 600) };
    return r.result?.result?.value;
  };
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true }, sessionId);
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(s.result.data, 'base64'));
    return path.join(OUT, name);
  };

  /* ---------- 1. 进入真实播放页（演示数据，不改数据层） ---------- */
  await send('Page.navigate', { url: BASE + '/#/welcome' }, sessionId);
  await sleep(2200);
  await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('同意'))?.click()`);
  await sleep(2200);
  await send('Page.navigate', { url: BASE + '/#/detail/demo:demo-002~oz59ns' }, sessionId);
  await sleep(2600);
  await ev(`document.querySelector('.detail-actions__main')?.click()`);
  await sleep(4000);

  /* ---------- 2. AC-40：纯函数判定（dev server 真实模块） ---------- */
  const detect = await ev(`(async () => {
    const m = await import('/src/player/sourceGuard.ts');
    const cases = [
      { name: 'mpd', url: 'https://cdn.example.com/v/manifest.mpd' },
      { name: 'mpd+query', url: 'https://cdn.example.com/v/manifest.mpd?a=1&token=x' },
      { name: 'm3u8 sample-aes', url: 'https://cdn.example.com/v/index.m3u8',
        text: '#EXTM3U\\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://license.example.com/"\\n#EXTINF:10,\\n1.ts' },
      { name: 'm3u8 plain', url: 'https://cdn.example.com/v/index.m3u8',
        text: '#EXTM3U\\n#EXT-X-VERSION:3\\n#EXTINF:10,\\n1.ts' },
      { name: 'mp4', url: 'https://cdn.example.com/v/a.mp4' },
      { name: 'mp4+query', url: 'https://cdn.example.com/v/a.mp4?token=1' },
    ];
    return cases.map((c) => {
      const err = m.detectUnsupportedSource(c.url, c.text ?? null);
      return { name: c.name, code: err ? err.code : null, message: err ? err.message : null, retryable: err ? err.retryable : null };
    });
  })()`);
  if (detect && detect.__exc) throw new Error(`detect eval 失败：${detect.__exc}`);

  // SAMPLE-AES 清单文本挂到页面（供真实链路预检 stub 与错误面板用例复用）
  await ev(`window.__DRM_MANIFEST__ = ${JSON.stringify([
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://license.example.com/"',
    '#EXTINF:10,',
    '1.ts',
  ].join(String.fromCharCode(10)))}`);

  /* ---------- 3. AC-40：真实 PlayerController 路径 ---------- */
  const realPath = await ev(`(async () => {
    const [{ PlayerController }, guardMod] = await Promise.all([
      import('/src/player/PlayerController.ts'),
      import('/src/player/sourceGuard.ts'),
    ]);
    const stage = document.createElement('div');
    stage.id = 'ac40-probe-stage';
    stage.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999;width:1px;height:1px;overflow:hidden;';
    document.body.appendChild(stage);

    // 记录加载期间是否创建 video / 发请求
    let fetches = 0;
    const origFetch = window.fetch;
    window.fetch = (...args) => { fetches += 1; return origFetch(...args); };
    const probe = async (url, format) => {
      fetches = 0;
      const ctl = new PlayerController({ onProgress: () => {} });
      ctl.mount(stage);
      let code = null, message = null;
      try {
        await ctl.load({
          mediaId: 'm', episodeId: 'e', lineId: 'l', title: 't', posterUrl: null,
          playback: { url, format, headers: {}, subtitles: [], lineId: 'l', quality: null, expiresAt: null, isLocal: false },
          startPositionSec: 0, totalEpisodes: 1, preferLocal: false,
          episodes: [{ episodeId: 'e', number: 1, title: '1' }],
        });
      } catch (e) { code = e.code ?? null; message = e.message ?? String(e); }
      const videoCount = document.querySelectorAll('#ac40-probe-stage video').length;
      await ctl.destroy();
      return { url: url.slice(0, 44), format, code, message, fetches, videoCount };
    };

    const out = {};
    // 与真实链路一致：mpd 时 resolvePlay 的 format 为 'other'
    out.mpd = await probe('https://cdn.example.com/v/manifest.mpd', 'other');
    out.mpdQuery = await probe('https://cdn.example.com/v/manifest.mpd?a=1', 'other');

    // 预检命中 SAMPLE-AES（stub fetch 返回加密清单）
    window.fetch = async () => new Response(window.__DRM_MANIFEST__);
    out.m3u8Drm = await probe('https://cdn.example.com/v/index.m3u8', 'hls');

    // 预检失败（网络抖动）→ 不得误判 DRM
    window.fetch = async () => { throw new TypeError('Failed to fetch'); };
    out.m3u8Flaky = await probe('https://cdn.example.com/v/index.m3u8', 'hls');

    // 诊断：确认预检与判定的中间值（stub fetch 返回加密清单）
    window.fetch = async () => new Response(window.__DRM_MANIFEST__);
    const diagText = await guardMod.preflightManifest('https://cdn.example.com/v/index.m3u8');
    const diagErr = guardMod.detectUnsupportedSource('https://cdn.example.com/v/index.m3u8', diagText);
    out.diag = { hasKeyLine: typeof diagText === 'string' && diagText.indexOf('SAMPLE-AES') !== -1, code: diagErr ? diagErr.code : null };

    window.fetch = origFetch;
    stage.remove();
    return out;
  })()`);
  if (realPath && realPath.__exc) throw new Error(`PlayerController eval 失败：${realPath.__exc}`);

  /* ---------- 4. 错误面板文案（真实组件，实测渲染） ---------- */
  // 用真实 PlayerErrorPanel 渲染两条错误，逐条截图取证
  const panel = await ev(`(async () => {
    const [{ createApp }, mod] = await Promise.all([
      import('/node_modules/.vite/deps/vue.js'),
      import('/src/components/player/PlayerErrorPanel.vue'),
    ]);
    const guard = await import('/src/player/sourceGuard.ts');
    const shapes = [
      guard.detectUnsupportedSource('https://a.com/manifest.mpd').toShape(),
      guard.detectUnsupportedSource('https://a.com/i.m3u8', window.__DRM_MANIFEST__).toShape(),
    ];
    const host = document.createElement('div');
    host.id = 'ac40-panel-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:99998;background:#000;display:flex;align-items:center;justify-content:center;';
    document.body.appendChild(host);
    const texts = [];
    for (const shape of shapes) {
      const app = createApp(mod.default, { error: shape, canSwitchLine: true });
      app.mount(host);
      await new Promise((r) => setTimeout(r, 150));
      const title = host.querySelector('.player-error__title')?.textContent ?? '';
      const hint = host.querySelector('.player-error__hint')?.textContent ?? '';
      texts.push({
        code: shape.code,
        title,
        hint,
        retryShown: !!host.querySelector('.player-error__actions .btn--primary'),
        switchLineShown: !!host.querySelector('.player-error__actions .btn--secondary'),
        backShown: [...host.querySelectorAll('.player-error__actions button')].some((b) => (b.textContent || '').includes('返回')),
      });
      app.unmount();
    }
    // 停留渲染 DASH 那条，供截图
    const lastApp = createApp(mod.default, { error: shapes[0], canSwitchLine: true });
    lastApp.mount(host);
    return { texts, __mounted: true };
  })()`);
  if (panel && panel.__exc) throw new Error(`错误面板 eval 失败：${panel.__exc}`);
  await sleep(400);
  const panelShotDash = await shot('ac40-error-panel-dash.png');

  // 换成 DRM 那条再截一张
  await ev(`(async () => {
    const host = document.querySelector('#ac40-panel-host');
    if (host) host.innerHTML = '';
    const [{ createApp }, mod] = await Promise.all([
      import('/node_modules/.vite/deps/vue.js'),
      import('/src/components/player/PlayerErrorPanel.vue'),
    ]);
    const guard = await import('/src/player/sourceGuard.ts');
    const shape = guard.detectUnsupportedSource('https://a.com/i.m3u8', window.__DRM_MANIFEST__).toShape();
    createApp(mod.default, { error: shape, canSwitchLine: true }).mount(host);
    return true;
  })()`);
  await sleep(400);
  const panelShotDrm = await shot('ac40-error-panel-drm.png');
  await ev(`document.querySelector('#ac40-panel-host')?.remove()`);

  /* ---------- 5. AC-52：全屏进入/退出时 setStatusBarVisible 的调用（spy） ---------- */
  // 用真实 deviceService 的 spy：进入全屏应收到 false，退出应收到 true。
  // Web 下原实现是 no-op，所以只能验证"调用发生"，状态栏是否真的隐藏需真机。
  await ev(`(async () => {
    const mod = await import('/src/services/deviceService.ts');
    window.__SB_CALLS__ = [];
    const orig = mod.deviceService.setStatusBarVisible;
    window.__SB_ORIG__ = orig;
    mod.deviceService.setStatusBarVisible = async (visible) => {
      window.__SB_CALLS__.push(visible);
      return orig.call(mod.deviceService, visible);
    };
    return true;
  })()`);

  await ev(`document.querySelector('[aria-label="全屏"]')?.click()`);
  await sleep(1600);
  const ac52Enter = await ev(`(() => ({
    calls: [...(window.__SB_CALLS__ || [])],
    fullscreen: !!document.querySelector('[aria-label="退出全屏"]'),
    immersiveRoot: !!document.querySelector('.player-root--landscape'),
    videos: document.querySelectorAll('video').length,
  }))()`);
  const fileFullscreen = await shot('ac52-fullscreen-statusbar-call.png');

  await ev(`document.querySelector('[aria-label="退出全屏"]')?.click()`);
  await sleep(1600);
  const ac52Exit = await ev(`(() => {
    const calls = [...(window.__SB_CALLS__ || [])];
    const mod = window.__SB_ORIG__;
    return { calls, backButtonVisible: !!document.querySelector('[aria-label="全屏"]') };
  })()`);

  // 还原 spy
  await ev(`(async () => {
    const mod = await import('/src/services/deviceService.ts');
    mod.deviceService.setStatusBarVisible = window.__SB_ORIG__;
    return true;
  })()`);

  const ac52 = { enter: ac52Enter, exit: ac52Exit };

  /* ---------- 6. 汇总断言 ---------- */
  const checks = [];
  const check = (id, name, ok, detail) => checks.push({ id, name, ok, detail });

  const d = (n) => detect.find((x) => x.name === n);
  const p = (code) => panel.texts.find((x) => x.code === code);
  check('AC40-06', '错误面板展示「暂不支持 DASH(.mpd) 格式」', p('E_UNSUPPORTED_FORMAT').title === '暂不支持 DASH(.mpd) 格式', p('E_UNSUPPORTED_FORMAT'));
  check('AC40-07', '错误面板展示「不支持受保护内容」', p('E_DRM_PROTECTED').title === '不支持受保护内容' && p('E_DRM_PROTECTED').retryShown === false, p('E_DRM_PROTECTED'));
  check('AC40-08', '错误面板不提供「重试」（明确拒绝、不引导重试绕过）', p('E_UNSUPPORTED_FORMAT').retryShown === false && p('E_DRM_PROTECTED').retryShown === false, {
    dashRetry: p('E_UNSUPPORTED_FORMAT').retryShown,
    drmRetry: p('E_DRM_PROTECTED').retryShown,
    dashBack: p('E_UNSUPPORTED_FORMAT').backShown,
  });
  check('AC40-09', '真实加载路径：.mpd 不发请求、不创建 video', realPath.mpd.fetches === 0 && realPath.mpd.videoCount === 0 && realPath.mpd.code === 'E_UNSUPPORTED_FORMAT', realPath.mpd);
  check('AC40-10', '真实加载路径：.mpd?a=1 同样拒绝', realPath.mpdQuery.code === 'E_UNSUPPORTED_FORMAT' && realPath.mpdQuery.videoCount === 0, realPath.mpdQuery);
  check('AC40-11', '真实加载路径：SAMPLE-AES m3u8 → E_DRM_PROTECTED 且未创建 video', realPath.m3u8Drm.code === 'E_DRM_PROTECTED' && realPath.m3u8Drm.videoCount === 0, realPath.m3u8Drm);
  check('AC40-12', '预检网络失败不误判 DRM（回退正常加载）', realPath.m3u8Flaky.code !== 'E_DRM_PROTECTED', realPath.m3u8Flaky);

  check('AC40-01', 'detectUnsupportedSource(.mpd) → E_UNSUPPORTED_FORMAT', d('mpd').code === 'E_UNSUPPORTED_FORMAT' && d('mpd').retryable === false, d('mpd'));
  check('AC40-02', '.mpd?a=1&token=x 仍识别为 DASH', d('mpd+query').code === 'E_UNSUPPORTED_FORMAT', d('mpd+query'));
  check('AC40-03', 'm3u8 + SAMPLE-AES → E_DRM_PROTECTED', d('m3u8 sample-aes').code === 'E_DRM_PROTECTED' && d('m3u8 sample-aes').message === '不支持受保护内容', d('m3u8 sample-aes'));
  check('AC40-04', '普通 m3u8 放行', d('m3u8 plain').code === null, d('m3u8 plain'));
  check('AC40-05', 'mp4 / mp4?token=1 放行', d('mp4').code === null && d('mp4+query').code === null, [d('mp4'), d('mp4+query')]);

  check('AC52-01', '点全屏 → deviceService.setStatusBarVisible(false) 被调用', ac52.enter.calls.join(',') === 'false' && ac52.enter.fullscreen && ac52.enter.immersiveRoot, ac52.enter);
  check('AC52-02', '退出全屏 → deviceService.setStatusBarVisible(true) 被调用', ac52.exit.calls.join(',') === 'false,true' && ac52.exit.backButtonVisible, ac52.exit);
  check('AC52-03', '全屏期间播放不中断（video 仍在，未重载）', ac52.enter.videos >= 1, { videos: ac52.enter.videos });

  // 在真实页面上叠加"验收板"，把断言结果与截图绑定
  await ev(`(() => {
    document.querySelector('#ac40-board')?.remove();
    const board = document.createElement('div');
    board.id = 'ac40-board';
    board.style.cssText = 'position:fixed;left:12px;top:12px;right:12px;z-index:99997;max-height:92vh;overflow:auto;' +
      'background:rgba(10,10,14,.94);border:1px solid #333;border-radius:12px;padding:14px;color:#eaeaea;' +
      'font:12px/1.55 ui-monospace,Menlo,Consolas,monospace;';
    const rows = ${JSON.stringify(checks)}.map((c) =>
      '<div style="display:flex;gap:8px;margin:4px 0"><span style="color:' + (c.ok ? '#3ddc84' : '#ff5c5c') + '">' +
      (c.ok ? 'PASS' : 'FAIL') + '</span><span style="flex:1">' + c.id + ' ' + c.name + '</span></div>').join('');
    board.innerHTML =
      '<div style="font-size:14px;font-weight:700;margin-bottom:8px">AC-40 / AC-52 实测断言（headless Chrome · 真实模块）</div>' +
      '<div style="color:#9aa;margin-bottom:10px">PlayerController.load 真实路径 + PlayerErrorPanel 真实组件 + deviceService spy</div>' +
      rows +
      '<div style="margin-top:10px;color:#3ddc84">合计 ' + ${JSON.stringify(checks.filter((c) => c.ok).length)} + '/' + ${JSON.stringify(checks.length)} + ' 通过</div>';
    document.body.appendChild(board);
    return true;
  })()`);
  await sleep(300);
  const file = await shot('ac40-ac52-assertions.png');

  const report = { detect, realPath, panel, ac52, checks, screenshots: { board: file, dashPanel: panelShotDash, drmPanel: panelShotDrm, fullscreen: fileFullscreen } };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));

  console.log('detect:', JSON.stringify(detect));
  console.log('realPath:', JSON.stringify(realPath));
  console.log('panel:', JSON.stringify(panel));
  console.log('ac52:', JSON.stringify(ac52));
  console.log('screenshots:', JSON.stringify(report.screenshots));
  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length ? `FAIL ${failed.length}` : `ALL ${checks.length} PASS`);

  await send('Browser.close');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('script error:', e.message);
  process.exit(2);
});
