/**
 * 管道真机/本机验证脚本
 *
 * 直接调用应用同一份管道代码，对探针服务的五类响应断言行为。
 * 用法：npx vite-node scripts/verify-pipeline.ts
 */
import { crawl, setRules } from '../src/sources/pipeline/scheduler';
import { defaultRules } from '../src/sources/pipeline/rules/defaults';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8911';

interface Check {
  name: string;
  run: () => Promise<string>;
  expect: (actual: string) => void;
}

const checks: Check[] = [
  {
    name: 'GBK 无 charset → 探测解码',
    run: async () => {
      const r = await crawl<{ text: string }>({ intent: 'subscription', url: `${BASE}/probe-gbk` });
      return r.value.text;
    },
    expect: (t) => {
      if (t !== '{"name":"中文"}') throw new Error(`解码错误：${JSON.stringify(t)}`);
    },
  },
  {
    name: 'BMP 伪装 application/json → 拒绝',
    run: async () => {
      try {
        await crawl({ intent: 'catalog', url: `${BASE}/probe-bmp` });
        return 'NOT_REJECTED';
      } catch (e) {
        const err = e as { code?: string; detail?: string };
        return `${err.code}|${err.detail ?? ''}`;
      }
    },
    expect: (r) => {
      if (!r.startsWith('E_UNSUPPORTED_FORMAT')) throw new Error(`期望拒绝，实际：${r}`);
      if (!/图片|bmp/i.test(r)) throw new Error(`detail 未标出图片/magic：${r}`);
    },
  },
  {
    name: 'RSS → xml.vod 归一',
    run: async () => {
      const r = await crawl<{ list: Array<Record<string, unknown>> }>({
        intent: 'catalog',
        url: `${BASE}/probe-xml`,
      });
      return `${r.ruleId}|${r.parserId}|${JSON.stringify(r.value.list[0] ?? null)}`;
    },
    expect: (r) => {
      if (!r.startsWith('catalog.xml-vod|xml.vod|')) throw new Error(`规则未命中：${r}`);
      if (!r.includes('XML 影片')) throw new Error(`未解析出标题：${r}`);
    },
  },
  {
    name: 'text/html 包 JSON（CHG-06）→ 接受',
    run: async () => {
      const r = await crawl<{ list: unknown[] }>({ intent: 'catalog', url: `${BASE}/probe-htmljson` });
      return `${r.ruleId}|${r.value.list.length}`;
    },
    expect: (r) => {
      if (r !== 'cms.json-on-html-mime|1') throw new Error(`规则/结果不符：${r}`);
    },
  },
  {
    name: '空响应 → 拒绝且说明为空',
    run: async () => {
      try {
        await crawl({ intent: 'catalog', url: `${BASE}/probe-empty` });
        return 'NOT_REJECTED';
      } catch (e) {
        const err = e as { code?: string; detail?: string };
        return `${err.code}|${err.detail ?? ''}`;
      }
    },
    expect: (r) => {
      if (!r.startsWith('E_UNSUPPORTED_FORMAT')) throw new Error(`期望拒绝，实际：${r}`);
      if (!/为空/.test(r)) throw new Error(`detail 未说明空响应：${r}`);
    },
  },
];

(async () => {
  setRules(defaultRules());
  let failed = 0;
  for (const check of checks) {
    try {
      const actual = await check.run();
      check.expect(actual);
      console.log(`PASS  ${check.name}`);
    } catch (e) {
      failed += 1;
      console.log(`FAIL  ${check.name}`);
      console.log(`      ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})();
