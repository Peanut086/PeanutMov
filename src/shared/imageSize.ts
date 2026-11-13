/**
 * 海报尺寸协商（P2-15）
 *
 * 源站下发的封面绝大多数是原图：600×900 起步，详情页顶部那条模糊背景用的也是
 * 同一张原图，而它最终要铺满 360 CSS px 再被 `blur(14~28px)` 糊掉——原分辨率
 * 对它是纯浪费。首屏 12~24 张卡片就是这个差别的总量。
 *
 * 边界（本模块全部的设计）：
 * - **只对能确定支持「按参数缩放」的对象存储主机下手**，其余主机原样返回。
 *   给未知主机加参数，轻则被忽略（白改），重则参数校验失败 400（图裂）。
 * - 只处理 `http(s)`；`data:` / `blob:` / 相对地址一律不动。
 * - 已经协商过的地址不重复加参数（同一张图可能被多个入口处理）。
 * - `paletteService` 把海报画进 canvas 取色：换 URL 等于换 CDN 缓存键，还可能
 *   触发一次没有缓存的跨源预检，那边继续用原图，**不要**接这里。
 */

/** 列表行内的小封面（46 CSS px 宽） */
export const IMG_W_INLINE = 160;
/** 首页「继续观看」横滑卡（112 CSS px 宽） */
export const IMG_W_COMPACT = 360;
/** 详情页主海报（96 CSS px 宽） */
export const IMG_W_POSTER = 320;
/** 海报墙卡片：两列时 ~180 CSS px，DPR≈3 */
export const IMG_W_CARD = 540;
/** 纯装饰的模糊背景层（详情页顶部 / 播放页音频舞台） */
export const IMG_W_BLUR = 480;

const OSS_PARAM = 'x-oss-process';
const COS_PARAM = 'imageMogr2';

interface HostRule {
  /** 主机是否属于这一族对象存储 */
  match: (host: string) => boolean;
  /** 缩放参数（`image/resize` 风格的分隔符不同，各家不通用） */
  query: (widthPx: number) => string;
}

const RULES: HostRule[] = [
  {
    // 阿里云 OSS
    match: (host) => host.endsWith('.aliyuncs.com'),
    query: (w) => `${OSS_PARAM}=image/resize,w_${w}/quality,q_80`,
  },
  {
    // 腾讯云 COS / 数据万象
    match: (host) => host.endsWith('.myqcloud.com'),
    query: (w) => `imageMogr2/thumbnail/${w}x/quality/80`,
  },
];

/** 追加一段**已自行编码好**的查询串（参数模板固定，宽度是数字，无需再转义整串） */
function appendRawQuery(url: string, query: string): string {
  const hashAt = url.indexOf('#');
  const head = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  return `${head}${head.includes('?') ? '&' : '?'}${query}${hash}`;
}

/**
 * 按目标显示宽度协商海报尺寸。
 *
 * @param url 源站海报地址（可为 null，原样透传）
 * @param widthPx 期望的**设备像素**宽度；≤0 表示不改写
 */
export function sizedImage<T extends string | null | undefined>(url: T, widthPx: number): T | null {
  if (!url || typeof url !== 'string' || widthPx <= 0) return (url ?? null) as T | null;
  if (!/^https?:\/\//i.test(url)) return url as T | null;
  if (url.includes(OSS_PARAM) || url.includes(COS_PARAM)) return url as T | null;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // 畸形地址（含空格等）交给浏览器自己处理，这里不添乱
    return url as T | null;
  }
  const rule = RULES.find((r) => r.match(host));
  if (!rule) return url as T | null;
  return appendRawQuery(url, rule.query(Math.round(widthPx))) as T | null;
}
