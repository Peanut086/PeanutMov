/**
 * 播放源可用性探测：启用一个可跨域的公开 MP4，验证播放器引擎端到端渲染。
 * 只做"能否加载/播放/写回进度"的功能验证，不修改任何演示片单数据。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PORT = 9355;
const BASE = 'http://localhost:5174';
const OUT = 'docs/03-设计规范/preview';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), 'pm-play-' + Date.now())}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(250); } }
  const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId); if (r.result?.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails).slice(0, 400); return r.result?.result?.value; };
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
  await send('Page.navigate', { url: BASE + '/#/welcome' }, sessionId);
  await sleep(2600);
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('同意')).click()`);
  await sleep(2600);

  // 在 IndexedDB 中选一条已有媒体，直接把播放地址换成可访问的公开样例（不改片单源文件）
  await ev(`location.hash='#/detail/demo:demo-002~oz59ns'`);
  await sleep(2600);
  console.log('detail title', await ev(`(document.querySelector('.detail-hero__title')||{}).textContent`));

  // 走真实播放链路：点主按钮
  await ev(`document.querySelector('.detail-actions__main').click()`);
  await sleep(9000);
  const st = await ev(`(()=>{const v=document.querySelector('video');if(!v)return JSON.stringify({hasVideo:false});const s=document.querySelector('.player-stage');const err=document.querySelector('[class*="error-panel"]');return JSON.stringify({hasVideo:true,src:v.currentSrc,rs:v.readyState,ns:v.networkState,dur:v.duration,t:v.currentTime,paused:v.paused,err:!!err,loading:!!document.querySelector('.player-loading'),title:(document.querySelector('.player-info__title')||{}).textContent})})()`);
  console.log('player state', st);
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(OUT, '05-player.png'), Buffer.from(shot.result.data, 'base64'));

  await sleep(6000);
  const st2 = await ev(`(()=>{const v=document.querySelector('video');return JSON.stringify({rs:v?v.readyState:null,t:v?Number(v.currentTime.toFixed(2)):null,dur:v?Number((v.duration||0).toFixed(2)):null,paused:v?v.paused:null})})()`);
  console.log('after 6s', st2);

  // 历史写回验证
  await ev(`location.hash='#/history'`);
  await sleep(3000);
  console.log('history', await ev(`(document.querySelector('[data-route="history"]')||{}).textContent?.replace(/\\s+/g,' ').slice(0,300)`));
  const shot2 = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(OUT, '07-history.png'), Buffer.from(shot2.result.data, 'base64'));

  await send('Browser.close');
})();
