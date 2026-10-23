/**
 * 「网页播放页 → 直链」端到端验证
 *
 * 场景：订阅里 demo-401 的播放地址是 /share/<id>（HTML 页面），
 * 真实 m3u8 明文写在页面 script 里。验证：
 *   1. 点播后不发视频请求给分享页本身；
 *   2. 解析出 /hls/share-demo.m3u8 并成功起播（currentTime 前进）；
 *   3. 错误面板不出现。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PORT = 9356;
const BASE = 'http://127.0.0.1:5174';
const OUT = 'docs/03-设计规范/preview';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  spawn(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${path.join(os.tmpdir(), 'pm-share-' + Date.now())}`,
      '--no-first-run',
      '--disable-gpu',
      '--hide-scrollbars',
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 60; i++) {
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
    if (r.result?.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails).slice(0, 300);
    return r.result?.result?.value;
  };
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  const requests = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
  });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);

  await send('Page.navigate', { url: BASE + '/#/welcome' }, sessionId);
  await sleep(2800);
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('同意'));if(b)b.click();return !!b})()`);
  await sleep(2000);

  // 导入本地订阅（若已导入则跳过）
  const imported = await ev(`(async()=>{
    const mod = await import('/src/stores/sourceStore.ts');
    const s = mod.useSourceStore();
    await s.load();
    if (!s.sources.some(x=>x.key==='local-tvbox')) {
      const imp = (await import('/src/stores/importStore.ts')).useImportStore();
      await imp.previewFromUrl('http://127.0.0.1:8802/sub.json');
      const p = imp.preview;
      await imp.commit({ selectedKeys: p.entries.filter(x=>x.valid).map(x=>x.key), onDuplicate: 'skip' });
      await s.load();
    }
    return s.sources.map(x=>x.key).join(',');
  })()`);
  console.log('sources:', imported);

  // 从搜索里拿到分享页样片的 mediaId
  const mediaId = await ev(`(async()=>{
    const lib = (await import('/src/stores/libraryStore.ts')).useLibraryStore();
    const src = (await import('/src/stores/sourceStore.ts')).useSourceStore();
    await src.load();
    const tv = src.sources.find(x=>x.key==='local-tvbox');
    if (!tv) return '';
    await lib.openSource(tv.id);
    await lib.search('分享页');
    const hit = lib.searchResults[0];
    return hit ? hit.id : '';
  })()`);
  console.log('mediaId:', mediaId);
  if (!mediaId) {
    console.log('FAIL: 未找到分享页样片');
    await send('Browser.close');
    return;
  }

  requests.length = 0;
  await send('Page.navigate', { url: `${BASE}/#/player/${mediaId}` }, sessionId);
  await sleep(1200);
  // 直接点主按钮播放（若在详情页）或已在播放器则点播放
  await ev(`(()=>{const b=document.querySelector('.detail-actions__main')||document.querySelector('.player-controls__play');if(b)b.click();return !!b})()`);
  await sleep(12000);

  const state = await ev(`(()=>{
    const v=document.querySelector('video');
    const panel=document.querySelector('.player-error');
    return JSON.stringify({
      hasVideo: !!v,
      src: v? v.currentSrc : null,
      readyState: v? v.readyState : null,
      duration: v? Number((v.duration||0).toFixed(2)) : null,
      currentTime: v? Number((v.currentTime||0).toFixed(2)) : null,
      paused: v? v.paused : null,
      errorPanel: !!panel,
      errorTitle: panel? (panel.querySelector('.player-error__title')||{}).textContent : null,
    });
  })()`);
  console.log('player:', state);
  console.log('hit /share/ request:', requests.filter((u) => u.includes('/share/')).length);
  console.log('hit /hls/share-demo.m3u8:', requests.filter((u) => u.includes('/hls/share-demo.m3u8')).length);

  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(OUT, 'share-page-player.png'), Buffer.from(shot.result.data, 'base64'));

  await send('Browser.close');
})();
