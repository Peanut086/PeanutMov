/**
 * 优酷直连弹幕源的实网冒烟（手动执行，不进 CI）：
 *   npx tsx tests/manual/youkuLiveSmoke.ts 甄嬛传 3
 * 目的：openapi 与 SSR 两条分集路、mtop 签名、分片解析都只能在真接口上验证。
 */
import { youkuProvider } from '@/services/danmaku/youku';

const [title = '甄嬛传', episodeText = '3'] = process.argv.slice(2);
const episode = Number(episodeText);

const result = await youkuProvider.match({ title, year: null, episode });
if (result === null) {
  console.log(`[youku] ${title} 第${episode}集：无匹配`);
  process.exit(0);
}
const sorted = [...result.comments].sort((a, b) => a.time - b.time);
console.log(`[youku] ${title} 第${episode}集 matchedTitle=${result.matchedTitle} count=${result.comments.length}`);
console.log('  最早 3 条:', JSON.stringify(sorted.slice(0, 3)));
console.log('  最晚 3 条:', JSON.stringify(sorted.slice(-3)));
console.log('  模式分布:', JSON.stringify(sorted.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.mode]: (acc[c.mode] ?? 0) + 1 }), {})));
