/**
 * 本地测试订阅服务（联调 / 模拟器自测用）
 *
 * 用途：给「订阅导入 → 源管理 → 浏览 → 播放」整条链路提供一份可用的测试数据。
 * 内容全部是公开版权样片（Blender 开放影片 / MDN 示例视频 / Mux 公开测试流），
 * 不涉及任何第三方影视站点。
 *
 * 用法：
 *   node scripts/mock-subscription-server.cjs
 *   浏览器导入地址：   http://127.0.0.1:8802/sub.json
 *   Android 模拟器：  http://10.0.2.2:8802/sub.json
 *   真机（同一局域网）：http://<本机局域网 IP>:8802/sub.json
 *
 * 订阅里的源地址会按请求 Host 自动改写，因此同一个 /sub.json 在三种环境下都能用。
 */
const http = require('node:http');
const os = require('node:os');

const PORT = Number(process.env.SUB_PORT || 8802);

/* ---------- 公开版权样片（全部 https，可直接播放） ---------- */
const MDN = 'https://mdn.github.io';
const V = {
  bbb: `${MDN}/dom-examples/picture-in-picture/assets/bigbuckbunny.mp4`,
  sintel: `${MDN}/shared-assets/videos/sintel-short.mp4`,
  tears: `${MDN}/shared-assets/videos/tears-of-steel-battle-clip-medium.mp4`,
  flower: `${MDN}/shared-assets/videos/flower.mp4`,
  friday: `${MDN}/shared-assets/videos/friday.mp4`,
  rabbit: `${MDN}/learning-area/html/multimedia-and-embedding/video-and-audio-content/rabbit320.mp4`,
  oceans: 'https://vjs.zencdn.net/v/oceans.mp4',
  blueMoon: 'https://cdn.plyr.io/static/demo/View_From_A_Blue_Moon_Trailer-720p.mp4',
  flowerWebm: `${MDN}/shared-assets/videos/flower.webm`,
  hls: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
};

const CLASSES = [
  { type_id: 1, type_name: '电影' },
  { type_id: 2, type_name: '电视剧' },
  { type_id: 3, type_name: '动漫' },
  { type_id: 4, type_name: '综艺' },
];

/** TVBox 风格的影片数据（字段与 SiteAdapter 的映射一致） */
const VODS = [
  {
    vod_id: 'demo-001',
    vod_name: 'Big Buck Bunny',
    type_id: 1,
    type_name: '电影',
    vod_year: '2008',
    vod_area: '美国',
    vod_score: '7.8',
    vod_remarks: '1080P',
    vod_content: 'Blender 基金会开放影片。MP4 与 HLS 双线路，用于验证线路切换与 hls.js 懒加载。',
    vod_play_from: 'MP4线路$$$HLS线路',
    vod_play_url: `正片$${V.bbb}$$$正片$${V.hls}`,
  },
  {
    vod_id: 'demo-002',
    vod_name: 'Sintel',
    type_id: 1,
    type_name: '电影',
    vod_year: '2010',
    vod_area: '荷兰',
    vod_score: '8.2',
    vod_remarks: '1080P',
    vod_content: 'Blender 基金会开放影片短片，用于验证单线路单集播放与续播。',
    vod_play_from: 'MP4线路',
    vod_play_url: `正片$${V.sintel}`,
  },
  {
    vod_id: 'demo-003',
    vod_name: 'Tears of Steel',
    type_id: 1,
    type_name: '电影',
    vod_year: '2012',
    vod_area: '荷兰',
    vod_score: '6.5',
    vod_remarks: '720P',
    vod_content: 'Blender 基金会开放影片片段，用于验证短时长视频的进度记录。',
    vod_play_from: 'MP4线路',
    vod_play_url: `正片$${V.tears}`,
  },
  {
    vod_id: 'demo-101',
    vod_name: '示例剧集 第一季',
    type_id: 2,
    type_name: '电视剧',
    vod_year: '2024',
    vod_area: '中国',
    vod_score: '8.8',
    vod_remarks: '全3集',
    vod_content: '用于验证多剧集、多线路、剧集切换与续播。',
    vod_play_from: '线路1$$$线路2',
    vod_play_url: `第1集$${V.flower}#第2集$${V.friday}#第3集$${V.rabbit}$$$第1集$${V.oceans}#第2集$${V.blueMoon}#第3集$${V.flowerWebm}`,
  },
  {
    vod_id: 'demo-201',
    vod_name: '动漫示例 短篇集',
    type_id: 3,
    type_name: '动漫',
    vod_year: '2023',
    vod_area: '日本',
    vod_score: '9.1',
    vod_remarks: '全2集',
    vod_content: '用于验证动漫分类与多集浏览。',
    vod_play_from: '线路1',
    vod_play_url: `第1集$${V.flower}#第2集$${V.flowerWebm}`,
  },
  {
    vod_id: 'demo-301',
    vod_name: '综艺示例 特别篇',
    type_id: 4,
    type_name: '综艺',
    vod_year: '2025',
    vod_area: '中国',
    vod_score: '7.2',
    vod_remarks: '全1集',
    vod_content: '用于验证综艺分类与单集内容。',
    vod_play_from: '线路1',
    vod_play_url: `正片$${V.oceans}`,
  },
];

/**
 * 网页播放页（/share/<id>）样片：`vod_play_url` 给的是 HTML 页面而非直链，
 * 用于验证 SiteAdapter 的「播放页 → 直链」解析（真实 CMS 采集站的常见形态）。
 * 页面里的地址写成**相对路径**，同时覆盖相对转绝对的分支。
 */
const SHARE_PAGE_ID = 'share-demo-1';
VODS.push({
  vod_id: 'demo-401',
  vod_name: '分享页线路（网页播放页）',
  type_id: 1,
  type_name: '电影',
  vod_year: '2026',
  vod_area: '测试',
  vod_score: '8.0',
  vod_remarks: '网页播放页',
  vod_content: '播放地址是 HTML 分享页，真实 m3u8 明文写在页面 script 里。',
  vod_play_from: '分享页线路',
  vod_play_url: `正片$/share/${SHARE_PAGE_ID}`,
});

/** 分享页 HTML：结构与真实采集站一致（相对路径 + 明文 m3u8） */
function sharePageHtml() {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>分享页样片</title></head>
<body><div id="container"></div>
<script>
    const vid = "${SHARE_PAGE_ID}";
    const url = "/hls/share-demo.m3u8";
    const pic = "/poster.jpg";
</script>
<script src="/frontend/players/js/hls.js"></script>
</body></html>`;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

/** 订阅内容：源地址按请求 Host 生成，浏览器 / 模拟器 / 局域网真机共用一份 */
function subscriptionFor(host) {
  const base = `http://${host}`;
  return {
    name: '本地测试订阅',
    version: 1,
    sources: [
      { key: 'local-tvbox', name: '本地样片站（可播放）', type: 'site', api: `${base}/tvbox` },
      { key: 'dead-tvbox', name: '不可用站点（健康检查失败）', type: 'site', api: `${base}/dead` },
      { key: 'local-alist', name: '本地 AList 模拟（可浏览）', type: 'alist', api: `${base}/alist` },
      { key: 'no-api', name: '缺地址的源（导入时跳过）', type: 'site' },
    ],
  };
}

/** TVBox 接口：ac=list / ac=detail / wd=关键词 */
function tvbox(req, res, url) {
  const ac = url.searchParams.get('ac') || 'list';
  const typeId = url.searchParams.get('t');
  const ids = url.searchParams.get('ids');
  const wd = url.searchParams.get('wd');
  const page = Number(url.searchParams.get('pg') || 1);

  let list = VODS;
  if (ac === 'detail' && ids) {
    list = VODS.filter((v) => v.vod_id === ids);
  } else if (wd) {
    const kw = wd.toLowerCase();
    list = VODS.filter((v) => v.vod_name.toLowerCase().includes(kw));
  } else if (typeId) {
    list = VODS.filter((v) => String(v.type_id) === String(typeId));
  }

  return json(res, 200, {
    code: 1,
    msg: '数据列表',
    page,
    pagecount: 1,
    limit: 20,
    total: list.length,
    class: CLASSES,
    list,
  });
}

/** AList 模拟：登录 / 列目录 / 取直链 */
function alist(req, res, url) {
  const path = url.pathname;
  if (path.endsWith('/api/auth/login')) {
    return json(res, 200, { code: 200, message: 'success', data: { token: 'mock-token' } });
  }
  if (path.endsWith('/api/fs/list')) {
    const items = [
      { name: 'Big Buck Bunny.mp4', is_dir: false, size: 4700000 },
      { name: 'Sintel.mp4', is_dir: false, size: 2200000 },
      { name: '示例剧集', is_dir: true, size: 0 },
    ];
    return json(res, 200, {
      code: 200,
      message: 'success',
      data: { content: items, total: items.length },
    });
  }
  if (path.endsWith('/api/fs/get')) {
    return json(res, 200, {
      code: 200,
      message: 'success',
      data: { name: 'Big Buck Bunny.mp4', raw_url: V.bbb, size: 4700000, is_dir: false },
    });
  }
  return json(res, 404, { code: 404, message: 'not found', data: null });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return text(
      res,
      200,
      [
        'PeanutMov 本地测试订阅服务',
        '',
        `订阅地址（浏览器）：http://127.0.0.1:${PORT}/sub.json`,
        `订阅地址（Android 模拟器）：http://10.0.2.2:${PORT}/sub.json`,
        `TVBox 接口：http://${req.headers.host}/tvbox?ac=detail`,
        `AList 模拟：http://${req.headers.host}/alist`,
        '',
        '内容均为公开版权样片，仅用于功能自测。',
      ].join('\n'),
    );
  }

  if (url.pathname === '/sub.json') return json(res, 200, subscriptionFor(req.headers.host));
  if (url.pathname === '/tvbox') return tvbox(req, res, url);
  /* ---------- v1.7/CHG-18 验收 fixtures（AC-113/114） ---------- */
  // HTML 落地页：同域 .json 候选 + meta refresh（模拟官网主页/短链跳转）
  if (url.pathname === '/landing') {
    const host = req.headers.host;
    return text(
      res,
      200,
      [
        '<!doctype html><html><head>',
        '<meta http-equiv="refresh" content="0; url=/sub.json">',
        '<title>影视站导航</title></head><body>',
        `<a href="/landing-sub.json">接口1</a>`,
        `<a href="http://other.example.com/x.json">外域（应被剔除）</a>`,
        '<script>location.href="/sub.json"</script>',
        '</body></html>',
      ].join('\n'),
    );
  }
  if (url.pathname === '/landing-sub.json') {
    return json(res, 200, { name: '落地页嗅探命中', sources: subscriptionFor(req.headers.host).sources.slice(0, 2) });
  }
  // 直播播放列表（m3u，2 路）与单流 m3u8
  if (url.pathname === '/live.m3u') {
    return text(res, 200, [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="cctv1" group-title="央视",CCTV-1 综合',
      `${V.hls}`,
      '#EXTINF:-1 group-title="央视",CCTV-2 财经',
      `${V.bbb}`,
      '',
    ].join('\n'));
  }
  if (url.pathname === '/single.m3u8') {
    return text(res, 200, `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\n${V.hls}\n`);
  }
  // 网页播放页（验证 SiteAdapter 的播放页 → 直链解析）
  if (url.pathname === `/share/${SHARE_PAGE_ID}`) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(sharePageHtml());
  }
  // 页面里引用的相对 m3u8：内容转发到公开 HLS 样片，保证真能播
  if (url.pathname === '/hls/share-demo.m3u8') {
    res.writeHead(302, { Location: V.hls, 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }
  if (url.pathname.startsWith('/alist')) return alist(req, res, url);
  if (url.pathname === '/bulk') {
    // 虚拟滚动回归用：返回 400 条公开样片（地址复用内置样片）
    const total = 400;
    const list = Array.from({ length: total }, (_, i) => ({
      vod_id: `bulk-${i}`,
      vod_name: `批量影片 ${String(i + 1).padStart(3, '0')}`,
      type_id: 1,
      type_name: '电影',
      vod_year: '2024',
      vod_area: '测试',
      vod_remarks: '批量',
      vod_content: '用于验证列表虚拟滚动（REV-11）。',
      vod_play_from: '线路1',
      vod_play_url: `正片$${V.bbb}`,
    }));
    return json(res, 200, { code: 1, class: CLASSES, list, total, pagecount: 1, page: 1 });
  }

  if (url.pathname === '/dead') return text(res, 503, 'service unavailable');
  if (url.pathname === '/dc.json') {
    const host = req.headers.host;
    return json(res, 200, { name: '本地多仓索引', urls: [{ url: `http://${host}/sub.json`, name: '本地测试订阅' }] });
  }
  if (url.pathname === '/legacy') {
    const ac = url.searchParams.get('ac');
    // 只认 ac=videolist：模拟老版 CMS，验证客户端的回退逻辑
    if (ac === 'videolist') {
      const t = url.searchParams.get('t');
      const ids = url.searchParams.get('ids');
      let list = ids ? VODS.filter((v) => v.vod_id === ids) : VODS;
      if (t) list = list.filter((v) => String(v.type_id) === String(t));
      return json(res, 200, { code: 1, class: CLASSES, list });
    }
    // 分类接口固定给 class；列表/搜索/详情给空（触发回退）
    return json(res, 200, { code: 1, class: CLASSES, list: [] });
  }

  return text(res, 404, 'not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);

  console.log(`本地测试订阅服务已启动（端口 ${PORT}）`);
  console.log(`  浏览器：      http://127.0.0.1:${PORT}/sub.json`);
  console.log(`  模拟器：      http://10.0.2.2:${PORT}/sub.json`);
  lan.forEach((ip) => console.log(`  局域网真机：  http://${ip}:${PORT}/sub.json`));
  console.log('按 Ctrl+C 停止');
});
