/**
 * 弹幕回退链实网冒烟（手动执行，不进 CI）：
 *   npx vite-node tests/manual/danmakuChainSmoke.ts
 *   npx vite-node tests/manual/danmakuChainSmoke.ts -- 狂飙 2023 1
 * 目的：验证「B 站 → 腾讯 → 芒果 → 爱奇艺 → 优酷 → 乐视 → dandanplay → 本地 xml」整条链
 *       在真实接口上的命中源、条数与耗时（含全部落空时的最长路径）。
 */
import 'fake-indexeddb/auto';

import { danmakuService } from '@/services/danmakuService';

/** 用法：`... -- 片名 [年份|-] [集号]`，年份传 `-` 表示不校验 */
const args = process.argv.slice(2);
const CASES: Array<{ title: string; year: number | null; episode: number }> =
  args.length > 0
    ? [
        {
          title: args[0] ?? '狂飙',
          year: args[1] === undefined || args[1] === '-' ? null : Number(args[1]),
          episode: Number(args[2] ?? '1'),
        },
      ]
    : [
        { title: '庆余年', year: 2019, episode: 1 },
        { title: '国色芳华', year: 2025, episode: 1 },
        { title: '狂飙', year: 2023, episode: 1 },
        { title: '莲花楼', year: 2023, episode: 1 },
        { title: '甄嬛传', year: 2011, episode: 3 },
        { title: '白鹿原', year: 2017, episode: 3 },
        // 乐视片库里腾讯/爱奇艺都没有版权的长尾剧，用来确认链路最后一级也在生效
        { title: '唐朝好男人2', year: null, episode: 5 },
        // 全链落空的最长路径（不存在的片名）
        { title: '这部片子根本不存在xyz', year: null, episode: 1 },
      ];

for (const item of CASES) {
  const started = Date.now();
  const match = await danmakuService.match(item.title, item.year, item.episode);
  const label = `${item.title}${item.year ? `(${item.year})` : ''} 第${item.episode}集`;
  if (match === null) {
    console.log(`${label.padEnd(26)} 无弹幕  ${Date.now() - started}ms`);
    continue;
  }
  const times = match.comments.map((c) => c.time);
  console.log(
    `${label.padEnd(26)} ${match.provider.padEnd(10)} ${String(match.comments.length).padStart(6)} 条` +
      `  ${Date.now() - started}ms  时间轴 ${Math.min(...times).toFixed(0)}~${Math.max(...times).toFixed(0)}s` +
      `  matchedTitle=${match.matchedTitle ?? '-'}`,
  );
}
