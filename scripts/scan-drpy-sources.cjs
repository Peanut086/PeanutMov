/**
 * 扫描订阅里的 drpy（JS 爬虫）源，检查其规则是否自带播放地址。
 *
 * 用法：node scripts/scan-drpy-sources.cjs [--concurrency N] [--timeout ms]
 *
 * 判定思路：
 * 1. 拉订阅 → 找 sites[] 里 api 以 .js 结尾的条目；
 * 2. 对每个 drpy 源拉取规则文件（ext 字段，或 api 本身就是规则）；
 * 3. 在规则源码里找播放相关键：二级 / lazy / play_parse / play_url / 播放 / vod_play_url；
 * 4. 输出：有播放能力的 drpy 源清单（可用于决定是否值得接 QuickJS）。
 */
const fs = require('node:fs');
const path = require('node:path');

const TIMEOUT = Number(process.env.TIMEOUT_MS || 20000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const OUT_DIR = '.drpy-scan';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36';

const urls = fs
  .readFileSync(path.join('scripts', 'fixtures', 'zhihu-tvbox-urls.txt'), 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith('#'));

/** 宽松解析：剥整行注释 + 去尾逗号 + 拼接折行字符串 */
function tolerantParse(text) {
  const strip = (s) => s.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const joinWrapped = (s) => {
    const lines = s.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      let q = 0;
      for (let j = 0; j < lines[i].length; j++) {
        if (lines[i][j] === '\\') { j++; continue; }
        if (lines[i][j] === '"') q++;
      }
      if (q % 2 === 1 && i + 1 < lines.length) { out.push(lines[i] + lines[i + 1]); i++; continue; }
      out.push(lines[i]);
    }
    return out.join('\n');
  };
  for (const fn of [(s) => s, strip, (s) => joinWrapped(strip(s))]) {
    try { return JSON.parse(fn(text)); } catch { /* next */ }
  }
  try { return JSON.parse(joinWrapped(strip(text)).replace(/,(\s*[}\]])/g, '$1')); } catch { return null; }
}

async function fetchText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT),
    redirect: 'follow',
    headers: { 'User-Agent': UA, Accept: '*/*' },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8') };
}

/** 规则源码里的播放能力特征 */
const PLAY_SIGNATURES = [
  { key: '二级', re: /二级\s*:\s*['"`]([^'"`]{1,80})/g },
  { key: 'lazy', re: /lazy\s*:\s*['"`]([^'"`]{1,80})/g },
  { key: 'play_parse', re: /play_parse\s*:\s*(true|false)/g },
  { key: 'play_url', re: /play_url|vod_play_url|播放地址|playUrl/g },
  { key: 'js:parse', re: /js:[\s\S]{0,40}(parse|sniff|嗅探)/g },
];

function playCapabilityOf(source) {
  const hits = [];
  for (const sig of PLAY_SIGNATURES) {
    sig.re.lastIndex = 0;
    const m = sig.re.exec(source);
    if (m) hits.push({ key: sig.key, value: String(m[1] ?? m[0]).slice(0, 60) });
  }
  // 二级为空串 / play_parse:false 视为「无播放」
  const detail = hits.find((h) => h.key === '二级');
  const parse = hits.find((h) => h.key === 'play_parse');
  const hasPlayUrl = hits.some((h) => h.key === 'play_url');
  const detailEmpty = detail !== undefined && detail.value.trim() === '';
  const parseOff = parse !== undefined && parse.value === 'false';
  const capable = hasPlayUrl && !(detailEmpty && parseOff);
  return { hits, capable, detailEmpty, parseOff, hasPlayUrl };
}

async function scanSubscription(url) {
  const result = { url, ok: false, reason: null, drpyCount: 0, capable: [] };
  try {
    const { status, text } = await fetchText(url);
    if (status !== 200) { result.reason = 'HTTP ' + status; return result; }
    const payload = tolerantParse(text);
    if (!payload || !Array.isArray(payload.sites)) { result.reason = '非订阅 JSON'; return result; }
    const drpy = payload.sites.filter(
      (s) => s && typeof s.api === 'string' && /^https?:\/\//i.test(s.api) && /\.m?js(?:[?#]|$)/i.test(s.api),
    );
    result.drpyCount = drpy.length;
    result.ok = true;
    for (const site of drpy) {
      const ruleUrl = typeof site.ext === 'string' && /^https?:\/\//i.test(site.ext) ? site.ext : site.api;
      const rec = { name: site.name, key: site.key, api: site.api, ruleUrl };
      try {
        const rule = await fetchText(ruleUrl);
        rec.ruleStatus = rule.status;
        if (rule.status === 200) {
          const cap = playCapabilityOf(rule.text);
          Object.assign(rec, cap);
          rec.ruleSize = rule.text.length;
        }
      } catch (e) {
        rec.ruleError = e.name;
      }
      result.capable.push(rec);
    }
    return result;
  } catch (e) {
    result.reason = e.name === 'TimeoutError' ? 'TIMEOUT' : e.message;
    return result;
  }
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    }),
  );
  return out;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`扫描 ${urls.length} 个订阅地址…\n`);
  const results = await pool(urls, CONCURRENCY, async (url, i) => {
    const r = await scanSubscription(url);
    const mark = !r.ok ? '×' : r.drpyCount > 0 ? `drpy ${r.drpyCount}` : '无drpy';
    console.log(`[${String(i + 1).padStart(3)}] ${mark.padEnd(10)} ${url.slice(0, 72)}${r.reason ? '  (' + r.reason + ')' : ''}`);
    return r;
  });

  const allDrpy = results.flatMap((r) => (r.capable || []).map((c) => ({ ...c, subscription: r.url })));
  const withRule = allDrpy.filter((c) => c.ruleStatus === 200);
  const playable = withRule.filter((c) => c.capable);

  fs.writeFileSync(path.join(OUT_DIR, 'all-drpy.json'), JSON.stringify(allDrpy, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'playable-drpy.json'), JSON.stringify(playable, null, 2));

  console.log(`\n${'='.repeat(70)}`);
  console.log(`订阅可解析: ${results.filter((r) => r.ok).length}/${urls.length}`);
  console.log(`drpy 源总数: ${allDrpy.length}`);
  console.log(`规则可下载: ${withRule.length}`);
  console.log(`规则自带播放能力: ${playable.length}`);
  if (playable.length > 0) {
    console.log('\n--- 自带播放能力的 drpy 源 ---');
    for (const p of playable) {
      console.log(`\n${p.name}  (${p.key})`);
      console.log(`  规则: ${p.ruleUrl.slice(0, 90)}`);
      console.log(`  特征: ${p.hits.map((h) => `${h.key}=${h.value}`).join(' | ')}`);
    }
  }
})();
