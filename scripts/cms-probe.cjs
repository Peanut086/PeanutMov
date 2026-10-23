/**
 * TVBox 采集站（CMS）订阅可用性探测工具
 *
 * 用途：给定一批 TVBox/tvbox 风格订阅地址，探测哪些源在 PeanutMov 里真正可用，
 * 并输出去重后的干净订阅 JSON + Markdown 报告。
 *
 * 背景：TVBox 订阅里 90% 以上是 type 3（csp_/drpy/jar）爬虫源，依赖 TVBox 客户端
 * 的 JVM 或 QuickJS 能力，H5 环境结构上无法支持。本工具只认 type 1 的 CMS
 * 采集站（api.php/provide/vod），并实测它是否真的能出播放地址。
 *
 * 判定一个 CMS 源"可用"需同时满足：
 *   1. HTTP 200 且响应是 TVBox JSON（非 HTML 落地页、非伪装图片）；
 *   2. 列表接口有数据；
 *   3. 详情接口（ac=detail&ids=）能取到播放地址，且不是 ?url= 解析包装。
 *
 * 用法：
 *   node scripts/cms-probe.cjs <urls文件> [选项]
 *
 *   urls 文件：纯文本，一行一个订阅地址（# 开头为注释）
 *   例：node scripts/cms-probe.cjs .tmp/zhihu-urls.txt
 *
 * 选项：
 *   --out <目录>     输出目录（默认 scripts/fixtures）
 *   --name <名称>    订阅名称（默认"PeanutMov 可用采集站"）
 *   --concurrency N  并发数（默认 6）
 *   --timeout <ms>   单请求超时（默认 15000）
 *   --report         额外输出 Markdown 探测报告
 *   --json           输出机器可读 JSON 汇总（stdout）
 *
 * 输出：
 *   <out>/cms-alive.json    去重后的可用源（TVBox 订阅格式，可直接导入）
 *
 * 注意：采集站稳定性差，建议每次导入前重跑一次。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/* ---------------- 参数解析 ---------------- */

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0].startsWith('--')) {
  console.error('用法: node scripts/cms-probe.cjs <urls文件> [选项]');
  console.error('     node scripts/cms-probe.cjs --help');
  process.exit(argv.includes('--help') ? 0 : 1);
}

const opts = {
  urlsFile: argv[0],
  out: 'scripts/fixtures',
  name: 'PeanutMov 可用采集站',
  concurrency: 6,
  timeout: 15000,
  report: false,
  json: false,
};

for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') opts.out = argv[++i];
  else if (a === '--name') opts.name = argv[++i];
  else if (a === '--concurrency') opts.concurrency = Number(argv[++i]);
  else if (a === '--timeout') opts.timeout = Number(argv[++i]);
  else if (a === '--report') opts.report = true;
  else if (a === '--json') opts.json = true;
  else {
    console.error(`未知选项: ${a}`);
    process.exit(1);
  }
}

/* ---------------- 工具函数 ---------------- */

const UA = 'okhttp/3.12.1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 剥离整行 // 注释（与 src/services/subscriptionParser.ts 的容错链保持一致） */
function stripLineComments(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

/** 一行里未转义双引号的数量 */
function quoteCount(line) {
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '"') count++;
  }
  return count;
}

/** 拼接被编辑器硬折行的字符串 */
function joinWrappedStrings(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (quoteCount(line) % 2 === 1 && i + 1 < lines.length) {
      out.push(line + lines[i + 1]);
      i++;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** 剥离 /* *\/ 块注释 */
function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 剥离 # 开头的行并清理悬空逗号（HG 线路等订阅用了 ## 分隔注释） */
function stripHashComments(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
}

/**
 * 容错解析链。真实 TVBox 订阅几乎都不是标准 JSON：
 * BOM 头、// 整行注释、/* *\/ 块注释、## 分隔注释、字符串被折行、
 * 悬空逗号都可能出现。顺序即优先级，任一步成功即返回。
 */
function tolerantParse(text) {
  const noBom = text.replace(/^\uFEFF/, '');
  const attempts = [
    () => JSON.parse(noBom),
    () => JSON.parse(joinWrappedStrings(stripLineComments(noBom))),
    () => JSON.parse(stripBlockComments(joinWrappedStrings(stripLineComments(noBom)))),
    () => JSON.parse(stripHashComments(stripBlockComments(joinWrappedStrings(stripLineComments(noBom))))),
  ];
  for (let i = 0; i < attempts.length; i++) {
    try {
      return { ok: true, value: attempts[i](), stage: i };
    } catch { /* 尝试下一步 */ }
  }
  return { ok: false, value: null, stage: -1 };
}

function looksLikeImage(buf) {
  const head = buf.slice(0, 8).toString('latin1');
  return /^(jfif|\x89png|bm|\xff\xd8|gif8)/i.test(head);
}

function looksLikeHtml(buf) {
  return /^\s*<(!doctype|html)/i.test(buf.slice(0, 200).toString('utf8'));
}

/** 带超时的 fetch */
async function fetchText(url, signal) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    redirect: 'follow',
    signal,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', buf };
}

function joinQuery(base, params) {
  const sep = base.includes('?') ? '&' : '?';
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}${sep}${qs}`;
}

/* ---------------- 探测逻辑 ---------------- */

/**
 * 探测一个 CMS 站点。
 * 返回 null 表示该地址不是可用的 CMS 源。
 */
async function probeCms(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    // 1. 列表接口
    const first = await fetchText(url, ac.signal);
    if (first.status !== 200) return null;
    if (looksLikeImage(first.buf) || looksLikeHtml(first.buf)) return null;
    if (first.contentType.toLowerCase().includes('image/')) return null;

    const parsed = tolerantParse(first.buf.toString('utf8'));
    if (!parsed.ok) return null;
    const payload = parsed.value;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

    const list = Array.isArray(payload.list) ? payload.list : Array.isArray(payload) ? payload : null;
    if (!list || list.length === 0) return null;

    const classes = Array.isArray(payload.class) ? payload.class.length : 0;
    const total = Number(payload.total ?? 0) || null;

    // 2. 详情接口取播放地址
    const firstVod = list.find((v) => v && (v.vod_id !== undefined && v.vod_id !== null));
    if (!firstVod) return null;
    const detailUrl = joinQuery(url, { ac: 'detail', ids: String(firstVod.vod_id) });
    const detail = await fetchText(detailUrl, ac.signal);
    if (detail.status !== 200) return null;
    const dParsed = tolerantParse(detail.buf.toString('utf8'));
    if (!dParsed.ok) return null;
    const dList = Array.isArray(dParsed.value?.list) ? dParsed.value.list : [];
    const vod = dList[0];
    if (!vod || typeof vod.vod_play_url !== 'string' || vod.vod_play_url.length === 0) return null;

    // 3. 播放地址必须是直连（.m3u8/.mp4/ share 链接），不能是 ?url= 解析包装
    const firstEp = vod.vod_play_url
      .split('$$$')[0]
      .split('#')[0]
      .split('$')
      .pop()
      .trim();
    if (!firstEp) return null;
    if (/\?url=/i.test(firstEp)) return null;

    return {
      url,
      classes,
      total,
      playSample: firstEp.slice(0, 120),
      vodName: typeof vod.vod_name === 'string' ? vod.vod_name : '',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 从一份订阅里抽取所有 CMS 候选地址（type 1 且 api 形如 api.php/provide/vod） */
function extractCmsCandidates(payload) {
  const sites = Array.isArray(payload?.sites)
    ? payload.sites
    : Array.isArray(payload?.sources)
      ? payload.sources
      : null;
  if (!sites) return [];
  return sites
    .filter((s) => {
      if (!s || typeof s !== 'object') return false;
      const api = typeof s.api === 'string' ? s.api.trim() : '';
      if (!/^https?:\/\//i.test(api)) return false;
      if (String(s.type) !== '1') return false;
      return /api\.php\/provide\/vod/i.test(api) || /\.php\/provide\/vod/i.test(api);
    })
    .map((s) => {
      const api = s.api.trim();
      const host = new URL(api).host.replace(/^www\./, '');
      return { url: api, host, name: typeof s.name === 'string' ? s.name.trim() : host };
    });
}

/** 探测一份订阅地址：返回它的 CMS 候选与可用情况 */
async function probeSubscription(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  const rec = { url, ok: false, note: '', candidates: 0, alive: 0 };
  try {
    const res = await fetchText(url, ac.signal);
    if (res.status !== 200) { rec.note = `HTTP ${res.status}`; return rec; }
    if (looksLikeImage(res.buf)) { rec.note = '图片伪装（反爬）'; return rec; }
    if (looksLikeHtml(res.buf)) { rec.note = 'HTML 落地页（防爬）'; return rec; }
    if (res.buf.toString('utf8').trim().length === 0) { rec.note = '空响应'; return rec; }

    const parsed = tolerantParse(res.buf.toString('utf8'));
    if (!parsed.ok) { rec.note = '非 JSON 也非 URL 列表'; return rec; }
    rec.ok = true;

    const cands = extractCmsCandidates(parsed.value);
    rec.candidates = cands.length;
    rec.note = cands.length > 0 ? `CMS 候选 ${cands.length} 个` : '无可用的 CMS 源';
    rec.candidateList = cands;
    return rec;
  } catch (e) {
    rec.note = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return rec;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 主流程 ---------------- */

(async () => {
  const raw = fs.readFileSync(opts.urlsFile, 'utf8');
  const urls = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  if (urls.length === 0) {
    console.error(`未在 ${opts.urlsFile} 中找到任何地址`);
    process.exit(1);
  }

  console.log(`共 ${urls.length} 个订阅地址，开始探测（并发 ${opts.concurrency}）...\n`);

  // 第一阶段：解析每个订阅，抽取 CMS 候选
  const subResults = new Array(urls.length);
  let cursor = 0;
  async function subWorker() {
    while (cursor < urls.length) {
      const i = cursor++;
      const r = await probeSubscription(urls[i], opts.timeout);
      subResults[i] = r;
      const tag = r.ok ? (r.candidates > 0 ? 'OK  ' : 'OK--') : 'FAIL';
      console.log(`[${tag}] ${urls[i]}\n       ${r.note}`);
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, subWorker));

  // 汇总候选（按主机去重）
  const byHost = new Map();
  for (const r of subResults) {
    for (const c of r.candidateList ?? []) {
      if (!byHost.has(c.host)) byHost.set(c.host, c);
    }
  }
  const candidates = [...byHost.values()];
  console.log(`\n抽取到 ${candidates.length} 个去重 CMS 候选，开始逐个实测...\n`);

  // 第二阶段：逐个实测 CMS 站点
  const alive = [];
  let c2 = 0;
  async function cmsWorker() {
    while (c2 < candidates.length) {
      const cand = candidates[c2++];
      const r = await probeCms(cand.url, opts.timeout);
      if (r) {
        alive.push({ ...cand, ...r });
        console.log(`[LIVE] ${cand.url}\n       ${r.classes} 分类 / ${r.total ?? '?'} 部 / ${r.playSample}`);
      } else {
        console.log(`[DEAD] ${cand.url}`);
      }
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, cmsWorker));

  // 按主机聚合信息量排序，同主机保留信息最多的
  alive.sort((a, b) => (b.total ?? 0) - (a.total ?? 0));

  // 源名清洗：TVBox 订阅的作者习惯用 | 分段（如「影视 | 暴風[直连]」），
  // 取最后一段并去掉 [直连]/[备] 之类标注，得到干净站名
  const cleanName = (raw, host) => {
    let n = String(raw ?? '').trim();
    if (n.length === 0) return host;
    if (n.includes('|')) n = n.split('|').pop().trim();
    n = n.replace(/[\[\(【（][^\]\)】）]*[\]\)】）]/g, '').trim();
    if (n.length === 0) return host;
    if (n.length > 40) n = n.slice(0, 40);
    return n;
  };

  const usedKeys = new Set();
  const sites = alive.map((s) => {
    const host = new URL(s.url).host.replace(/^www\./, '');
    let key = `cms_${host.replace(/[^a-z0-9]/gi, '')}`;
    // key 必须唯一，否则导入时会被判 DUPLICATE_KEY 而跳过
    if (usedKeys.has(key)) {
      let n = 2;
      while (usedKeys.has(`${key}_${n}`)) n++;
      key = `${key}_${n}`;
    }
    usedKeys.add(key);
    return {
      key,
      name: cleanName(s.name, host),
      type: 1,
      api: s.url,
      searchable: 1,
      quickSearch: 1,
      filterable: 1,
    };
  });

  fs.mkdirSync(opts.out, { recursive: true });
  const outFile = path.join(opts.out, 'cms-alive.json');
  fs.writeFileSync(
    outFile,
    JSON.stringify({ name: opts.name, sites }, null, 2) + '\n',
  );

  console.log(`\n=== 汇总 ===`);
  console.log(`订阅地址: ${urls.length} 个，可解析 ${subResults.filter((r) => r.ok).length} 个`);
  console.log(`CMS 候选: ${candidates.length} 个，实测可用 ${alive.length} 个`);
  console.log(`输出: ${outFile}`);

  if (opts.report) {
    const date = new Date().toISOString().slice(0, 10);
    const lines = [];
    lines.push(`# TVBox 接口探测报告（${date}）`);
    lines.push('');
    lines.push(`来源：${opts.urlsFile}（${urls.length} 个订阅地址）`);
    lines.push('');
    lines.push('## 订阅地址解析');
    lines.push('');
    lines.push('| 地址 | 结果 | CMS 候选 |');
    lines.push('| --- | --- | --- |');
    for (const r of subResults) {
      lines.push(`| ${r.url} | ${r.ok ? '可解析' : '不可解析'} | ${r.candidates} |`);
    }
    lines.push('');
    lines.push('## 可用 CMS 源');
    lines.push('');
    lines.push('| 源 | 分类数 | 影片总数 | 播放地址样例 |');
    lines.push('| --- | --- | --- | --- |');
    for (const s of alive) {
      // 源名里的 | 会破坏 Markdown 表格结构，转义为 \|
      const name = cleanName(s.name, s.host).replace(/\|/g, '\\|');
      lines.push(`| ${name} | ${s.classes} | ${s.total ?? '?'} | \`${s.playSample}\` |`);
    }
    lines.push('');
    lines.push(`判定标准：HTTP 200 + TVBox JSON + 列表非空 + 详情可取到直连播放地址（非 \`?url=\` 解析包装）。`);
    lines.push('');
    const reportFile = path.join(opts.out, `cms-probe-report-${date}.md`);
    fs.writeFileSync(reportFile, lines.join('\n'));
    console.log(`报告: ${reportFile}`);
  }

  if (opts.json) {
    console.log(JSON.stringify({
      total: urls.length,
      parsed: subResults.filter((r) => r.ok).length,
      candidates: candidates.length,
      alive: alive.length,
      sites: alive.map((s) => ({ name: s.name, url: s.url, classes: s.classes, total: s.total, playSample: s.playSample })),
    }, null, 2));
  }
})().catch((e) => {
  console.error('探测失败:', e);
  process.exit(1);
});
