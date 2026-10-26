/**
 * 推荐订阅全链路健康探测（2026-10-26）
 *
 * 对 recommended.json 里的每个订阅：
 *   1. 订阅本身可达性 + 解析（容错 JSON）
 *   2. 站点分类统计：type 0/1 CMS、type 3 spider（jar/csp_/drpy）、解析包装
 *   3. jar / drpy js 资源可达性（HEAD/GET 首字节）
 *   4. CMS 源抽样实测：分类列表 → 详情 → 取第一集播放地址 → 真实拉流验证
 *      （状态码 / content-type / 是否 #EXTM3U / ftyp / 是否需要 Referer）
 *   5. 失败分类汇总 → Markdown 报告
 *
 * 用法: node scripts/source-health-probe.cjs [--sub fty.json] [--out report.md]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const UA = 'okhttp/3.12.1';
const TIMEOUT = 15000;

/* ---------------- fetch helpers ---------------- */

async function fetchText(url, { headers = {}, timeout = TIMEOUT } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      redirect: 'follow',
      signal: ac.signal,
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, headers: res.headers, body };
  } catch (e) {
    return { ok: false, status: 0, error: String(e && e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function fetchHead(url, { headers = {}, timeout = TIMEOUT } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    let res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Range: 'bytes=0-16383', ...headers },
      redirect: 'follow',
      signal: ac.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: res.ok, status: res.status,
      contentType: res.headers.get('content-type') || '',
      body: buf,
    };
  } catch (e) {
    return { ok: false, status: 0, error: String(e && e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- 容错解析（对齐 subscriptionParser 思路，精简版） ---------------- */

function tryParseJson(text) {
  const attempts = [
    () => JSON.parse(text),
    () => JSON.parse(text.replace(/^\uFEFF/, '')),
    // 整行 // 注释
    () => JSON.parse(text.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n')),
    // /* */ 块注释
    () => JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '')),
    // # 注释 + 悬空逗号
    () => JSON.parse(text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n').replace(/,\s*([}\]])/g, '$1')),
    // 单引号
    () => JSON.parse(text.replace(/'/g, '"')),
  ];
  for (const fn of attempts) {
    try { return fn(); } catch { /* next */ }
  }
  return null;
}

/* ---------------- 站点分类 ---------------- */

function classifySite(site) {
  const api = String(site.api || '');
  const type = Number(site.type ?? -1);
  if (type === 0 || type === 1) {
    if (/jx=|url=|\/parse\//.test(api)) return 'parse-wrapper';
    return 'cms';
  }
  if (type === 4) return 'drpy'; // 部分订阅用 4 标 drpy
  if (type === 3) {
    if (/^csp_/i.test(api)) return 'spider-jar';
    if (/\.js($|\?)/.test(api) || /assets:\/|drpy/i.test(api)) return 'spider-js';
    if (/^http/.test(api)) return 'spider-http';
    return 'spider-unknown';
  }
  return `unknown-type${site.type}`;
}

/* ---------------- CMS 实测 ---------------- */

async function probeCmsSite(site, name) {
  const api = String(site.api || '').replace(/&amp;/g, '&');
  const result = { name, api, steps: [], verdict: '', playUrl: null };

  // 1. 分类列表
  let catResp = await fetchText(`${api}?ac=list`);
  let cats = [];
  try { cats = (JSON.parse(catResp.body || '{}').class || []).slice(0, 6); } catch {}
  if (!cats.length) {
    // 有些站 ac=videolist 直接可用
    const r2 = await fetchText(`${api}?ac=videolist&pg=1`);
    try {
      const j = JSON.parse(r2.body || '{}');
      if (Array.isArray(j.list) && j.list.length) {
        result.steps.push(`list-direct:${j.list.length}`);
        return await probeDetail(api, j.list[0].vod_id, result, name);
      }
    } catch {}
    result.verdict = `列表失败(status=${catResp.status}${catResp.error ? ' ' + catResp.error : ''})`;
    return result;
  }
  result.steps.push(`cats:${cats.length}`);

  // 2. 取第一个分类的影片列表
  const listResp = await fetchText(`${api}?ac=videolist&t=${cats[0].type_id}&pg=1`);
  let vods = [];
  try { vods = (JSON.parse(listResp.body || '{}').list) || []; } catch {}
  if (!vods.length) { result.verdict = `影片列表空(status=${listResp.status})`; return result; }
  result.steps.push(`vods:${vods.length}`);

  return await probeDetail(api, vods[0].vod_id, result, name);
}

async function probeDetail(api, id, result, name) {
  // 3. 详情
  const detResp = await fetchText(`${api}?ac=detail&ids=${id}`);
  let vod = null;
  try { vod = (JSON.parse(detResp.body || '{}').list || [])[0]; } catch {}
  if (!vod || !vod.vod_play_url) { result.verdict = `详情失败(status=${detResp.status})`; return result; }

  // 4. 第一集播放地址
  const firstFlag = (vod.vod_play_from || '').split('$$$')[0];
  const firstSet = (vod.vod_play_url || '').split('$$$')[0] || '';
  const ep = (firstSet.split('#')[0] || '');
  const playUrl = ep.split('$').pop();
  result.playUrl = playUrl;
  if (!/^https?:\/\//.test(playUrl)) {
    result.verdict = `播放地址非直链(${playUrl.slice(0, 50)})`;
    return result;
  }
  result.steps.push(`play:${firstFlag}`);

  // 5. 真实拉流验证
  const r = await fetchHead(playUrl);
  const ct = r.contentType || '';
  const head = r.body ? r.body.slice(0, 16) : Buffer.alloc(0);
  const isM3u8 = /^#EXTM3U/.test((r.body || Buffer.alloc(0)).toString('utf8', 0, 64));
  const isMp4 = head.length > 12 && head.slice(4, 8).toString('latin1') === 'ftyp';
  if (r.ok && (isM3u8 || isMp4 || /mpegurl|mp4|video\//i.test(ct))) {
    result.verdict = `OK(${isM3u8 ? 'm3u8' : isMp4 ? 'mp4' : ct}, http${r.status})`;
  } else {
    // 试一次带 Referer（站点域名）
    let origin = '';
    try { origin = new URL(playUrl).origin; } catch {}
    const r2 = await fetchHead(playUrl, { headers: { Referer: origin + '/' } });
    const head2 = r2.body ? r2.body.slice(0, 64).toString('utf8') : '';
    if (r2.ok && (/^#EXTM3U|ftyp/.test((r2.body || Buffer.alloc(0)).slice(0, 16).toString('latin1')) || /mpegurl|video\//i.test(r2.contentType || ''))) {
      result.verdict = `OK-需Referer(http${r2.status}, 首次http${r.status}${r2.error || ''})`;
    } else {
      result.verdict = `拉流失败(http${r.status} ct=${ct || '-'} ${r.error || head2.slice(0, 24).replace(/[^\x20-\x7e]/g, ' ')})`;
    }
  }
  return result;
}

/* ---------------- jar / js 资源可达性 ---------------- */

async function probeAsset(url) {
  if (!/^https?:\/\//.test(url)) return { url, verdict: `非http(${url.slice(0, 40)})` };
  const r = await fetchHead(url);
  if (r.ok && r.body && r.body.length > 1024) {
    return { url, verdict: `OK(${r.body.length}B ct=${r.contentType || '-'})` };
  }
  if (r.status === 403 || r.status === 404 || r.status === 0) {
    return { url, verdict: `失败(http${r.status} ${r.error || ''})` };
  }
  return { url, verdict: `可疑(http${r.status} ${r.body ? r.body.length : 0}B)` };
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const recommended = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/data/recommended/recommended.json'), 'utf8'));
  const subs = recommended.items.filter((s) => !s.tags.includes('直播'));
  const report = [];

  for (const sub of subs) {
    const entry = { name: sub.name, url: sub.url, sites: 0, breakdown: {}, jars: [], cmsSamples: [], verdict: '' };
    console.error(`\n===== ${sub.name} ${sub.url}`);
    const t0 = Date.now();
    const resp = await fetchText(sub.url, { timeout: 20000 });
    if (!resp.ok) { entry.verdict = `订阅不可达(http${resp.status} ${resp.error || ''})`; report.push(entry); continue; }
    const cfg = tryParseJson(resp.body);
    if (!cfg || !Array.isArray(cfg.sites) || !cfg.sites.length) {
      entry.verdict = `非TVBox配置或无sites(${resp.body.slice(0, 60).replace(/\s+/g, ' ')})`;
      report.push(entry); continue;
    }
    entry.sites = cfg.sites.length;
    for (const s of cfg.sites) {
      const k = classifySite(s);
      entry.breakdown[k] = (entry.breakdown[k] || 0) + 1;
    }
    console.error(`  sites=${entry.sites} ${JSON.stringify(entry.breakdown)} (${Date.now() - t0}ms)`);

    // jar 资源（去重，最多 3 个）
    const jarUrls = [...new Set(cfg.sites.map((s) => String(s.jar || '').split(';')[0]).filter((u) => /^https?:/.test(u)))].slice(0, 3);
    entry.jars = await Promise.all(jarUrls.map(probeAsset));
    for (const j of entry.jars) console.error(`  jar ${j.verdict} <- ${j.url.slice(0, 60)}`);

    // drpy js 资源抽样
    const jsSites = cfg.sites.filter((s) => classifySite(s) === 'spider-js').slice(0, 2);
    for (const s of jsSites) {
      const u = String(s.api).startsWith('http') ? String(s.api) : null;
      if (u) { const r = await probeAsset(u); console.error(`  js  ${r.verdict} <- ${u.slice(0, 60)}`); }
    }

    // CMS 抽样实测（最多 6 个）
    const cmsSites = cfg.sites.filter((s) => classifySite(s) === 'cms').slice(0, 6);
    const conc = [];
    for (const s of cmsSites) conc.push(probeCmsSite(s, s.name || s.key || s.api));
    entry.cmsSamples = await Promise.all(conc);
    for (const c of entry.cmsSamples) console.error(`  cms [${c.name}] ${c.verdict} ${c.playUrl ? '<- ' + c.playUrl.slice(0, 70) : ''}`);

    // spider 源 app 内才可测，给出提示
    entry.verdict = `订阅OK sites=${entry.sites}`;
    report.push(entry);
  }

  // 输出
  const lines = ['# 推荐订阅全链路健康探测报告', '', `时间: ${new Date().toISOString()}`, ''];
  for (const e of report) {
    lines.push(`## ${e.name}`);
    lines.push(`- 订阅: ${e.url}`);
    lines.push(`- 判定: ${e.verdict}`);
    if (e.sites) lines.push(`- 站点分布: ${JSON.stringify(e.breakdown)}`);
    for (const j of e.jars || []) lines.push(`- jar: ${j.verdict} \`${j.url}\``);
    if (e.cmsSamples && e.cmsSamples.length) {
      lines.push('- CMS 抽样:');
      for (const c of e.cmsSamples) lines.push(`  - [${c.name}] ${c.verdict}${c.playUrl ? '  `' + c.playUrl.slice(0, 90) + '`' : ''}`);
    }
    lines.push('');
  }
  const outPath = path.join(__dirname, 'fixtures/source-health-report.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log('\n报告: ' + outPath);
  console.log(JSON.stringify(report.map(({ jars, cmsSamples, ...rest }) => ({
    ...rest,
    jars: (jars || []).map((j) => j.verdict),
    cms: (cmsSamples || []).map((c) => `${c.name}: ${c.verdict}`),
  })), null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
