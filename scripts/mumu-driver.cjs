/**
 * MuMu 模拟器实测驱动器（WebView DevTools）
 *
 * 用法：
 *   node scripts/mumu-driver.cjs <command> [args]
 *
 * 命令：
 *   eval <js>        在当前页执行表达式并打印结果
 *   hash <route>     切换路由
 *   shot <file>      截图到 docs/03-设计规范/preview/<file>
 *   tap <x> <y>      点击屏幕坐标（1600x900 逻辑像素）
 *   text             打印当前页文本
 *   requests <ms>    监听 N 毫秒内的网络请求
 */
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.WV_PORT || 9333;
const OUT = process.env.SHOT_DIR || 'docs/03-设计规范/preview';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((p) => p.type === 'page');
  if (!page) throw new Error('未找到 WebView 页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  let id = 0;
  const pend = new Map();
  const requests = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
      return;
    }
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pend.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails).slice(0, 400);
    return r.result?.result?.value;
  };
  return { ws, send, ev, requests };
}

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  const { ws, send, ev, requests } = await connect();

  switch (cmd) {
    case 'eval':
      console.log(await ev(args.join(' ')));
      break;
    case 'hash':
      await ev(`location.hash = ${JSON.stringify(args[0])}`);
      await sleep(Number(args[1] || 1800));
      console.log('hash =', await ev('location.hash'));
      break;
    case 'shot': {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, args[0] || 'mumu.png');
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
      console.log('saved', file);
      break;
    }
    case 'tap': {
      const x = Number(args[0]);
      const y = Number(args[1]);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      }
      await sleep(Number(args[2] || 1200));
      console.log('tapped', x, y);
      break;
    }
    case 'text':
      console.log(await ev(`document.body.innerText.replace(/\\s+/g,' ').slice(0,1500)`));
      break;
    case 'requests': {
      await sleep(Number(args[0] || 3000));
      const uniq = [...new Set(requests)];
      console.log(uniq.join('\n'));
      break;
    }
    default:
      console.log('未知命令，见文件头注释');
  }
  ws.close();
})();
