/**
 * 标题海报生成（P2-7）
 *
 * 两类场景共用：源站没给 `vod_pic`（字段缺失），以及给了地址但加载失败
 * （防盗链 / 域名已死）。真机实测设备缓存 947 条条目的 `posterUrl` 没有一条为空，
 * 抽样 6 个海报主机有 3 个 `new Image()` 加载 timeout 或 error——所以「有字段」
 * 不等于「渲染得出来」，渲染层也需要一张兜底图，否则满屏「无封面」。
 *
 * 刻意不用 `demoPoster`：那张图带 `DEMO` / `PUBLIC DOMAIN SAMPLE` 字样，
 * 是给内置演示片单标身份的。真实影片套上它等于谎称公有领域样片。
 *
 * 返回 `data:` URI（SVG），离线可渲染、不产生额外网络请求。
 */

const W = 300;
const H = 450;
/** 左右各留 24px 出血后的可用宽度 */
const USABLE = W - 48;
const LINE_HEIGHT = 1.3;

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (ch) => {
    switch (ch) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      default:
        return '&quot;';
    }
  });
}

/** 同一标题恒得同一色相：列表刷新后卡片颜色不能跳 */
function hueOf(title: string): number {
  let hash = 0;
  for (let i = 0; i < title.length; i += 1) hash = (hash * 31 + title.charCodeAt(i)) % 360;
  return hash;
}

/**
 * 按字号折行，取「不超过 3 行」里最大的字号。
 *
 * 每行字数按全角估（`USABLE / fontSize`）：拉丁字母实际更窄，估窄只会让行数偏多，
 * 不会把文字顶出画面。
 */
function layout(chars: string[]): { lines: string[]; fontSize: number } {
  for (const fontSize of [40, 32, 26, 22]) {
    const perLine = Math.max(1, Math.floor(USABLE / fontSize));
    if (chars.length <= perLine * 3) {
      const lines: string[] = [];
      for (let i = 0; i < chars.length; i += perLine) lines.push(chars.slice(i, i + perLine).join(''));
      return { lines, fontSize };
    }
  }
  const perLine = Math.floor(USABLE / 20);
  const lines: string[] = [];
  for (let i = 0; i < chars.length && lines.length < 3; i += perLine) {
    const slice = chars.slice(i, i + perLine);
    if (lines.length === 2) slice.pop();
    lines.push(slice.join('') + (lines.length === 2 ? '…' : ''));
  }
  return { lines, fontSize: 20 };
}

/** 生成 2:3 标题海报；`hue` 省略时按标题定色 */
export function titlePoster(title: string, hue?: number): string {
  const chars = Array.from(title.trim());
  const { lines, fontSize } = layout(chars.length > 0 ? chars : ['未命名']);
  const color = hue ?? hueOf(chars.join(''));
  // 底部对齐：与真实海报的片名位置一致，视觉上不会显得文字浮在中间
  const lastBaseline = H - 40;
  const body = lines
    .map((line, index) => {
      const fromEnd = lines.length - 1 - index;
      const y = lastBaseline - fromEnd * fontSize * LINE_HEIGHT;
      return `<text x="24" y="${y.toFixed(1)}" fill="#f4f4f5" font-family="system-ui, sans-serif" font-size="${fontSize}" font-weight="600">${escapeXml(line)}</text>`;
    })
    .join('\n  ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${color} 34% 26%)"/>
      <stop offset="1" stop-color="hsl(${(color + 32) % 360} 30% 11%)"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <circle cx="246" cy="70" r="92" fill="hsl(${color} 58% 62%)" opacity="0.16"/>
  <circle cx="52" cy="150" r="46" fill="hsl(${(color + 200) % 360} 52% 60%)" opacity="0.1"/>
  ${body}
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
