/**
 * 乐视直连弹幕源的实网冒烟（手动执行，不进 CI）：
 *   npx vite-node tests/manual/leLiveSmoke.ts -- 白鹿原 3
 * 目的：搜索块解析、集号→vid、播放页时长与 300s 窗口都只能在真接口上验证。
 */
import { leshiProvider } from '@/services/danmaku/leshi';

const [title = '白鹿原', episodeText = '1'] = process.argv.slice(2);
const episode = Number(episodeText);

const result = await leshiProvider.match({ title, year: null, episode });
if (result === null) {
  console.log(`[leshi] ${title} 第${episode}集：无匹配`);
  process.exit(0);
}
const sorted = [...result.comments].sort((a, b) => a.time - b.time);
console.log(`[leshi] ${title} 第${episode}集 matchedTitle=${result.matchedTitle} count=${result.comments.length}`);
console.log('  最早 3 条:', JSON.stringify(sorted.slice(0, 3)));
console.log('  最晚 3 条:', JSON.stringify(sorted.slice(-3)));
console.log(
  '  模式分布:',
  JSON.stringify(sorted.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.mode]: (acc[c.mode] ?? 0) + 1 }), {})),
);
console.log(
  '  彩色条数:',
  sorted.filter((c) => c.color !== 0xffffff).length,
);
