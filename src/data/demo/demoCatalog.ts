/**
 * 内置演示片单（技术方案 3.9 / FR-43 / AC-95、AC-96）
 *
 * 约束：
 * - ≥12 个条目，覆盖电影 / 剧集 / 动漫 / 综艺；
 * - ≥2 部剧集各 ≥3 集；
 * - 全部播放地址为 `https:`；至少 1 条 HLS；
 * - 海报使用内联 SVG data URL，离线也能渲染，不依赖网络图片。
 *
 * 片源均为公开示例视频（Blender 开放影片 / Google Media Element / Mux 测试流），
 * 均为 CDN 且响应 `Access-Control-Allow-Origin: *`（播放器不设 `crossOrigin`，
 * 但仍要求可跨域，便于将来接 canvas 抓帧）。
 */
import type { MediaFormat, MediaType } from '@/types';

export interface DemoEpisodeSeed {
  title: string;
  durationSec: number;
  url: string;
}

export interface DemoLineSeed {
  name: string;
  quality: string | null;
  format: MediaFormat;
  /** 该线路的剧集（电影为 1 集） */
  episodes: DemoEpisodeSeed[];
}

export interface DemoItemSeed {
  itemId: string;
  title: string;
  originalTitle: string | null;
  type: MediaType;
  year: number | null;
  area: string | null;
  genres: string[];
  tags: string[];
  rating: number | null;
  description: string;
  /** 电影时长；剧集为 null，由各集时长表示 */
  durationSec: number | null;
  /** 海报主色相（0-360），用于内联 SVG */
  hue: number;
  lines: DemoLineSeed[];
}

export interface DemoCategorySeed {
  value: string;
  name: string;
  order: number;
}

/* ---------- 公开样片地址 ---------- */

/**
 * MDNGITHUB（`Access-Control-Allow-Origin: *`，支持 Range，离线不可用但播放器可直连）
 * - Big Buck Bunny（MP4，4.7MB）
 * - Sintel 短片 / Tears of Steel 片段 / flower / friday / rabbit320 / oceans / View From A Blue Moon
 * - HLS 多码率测试流（Mux，BBBB）
 */
const MDN = 'https://mdn.github.io';
const BBB_MP4 = `${MDN}/dom-examples/picture-in-picture/assets/bigbuckbunny.mp4`;
const SINTEL_MP4 = `${MDN}/shared-assets/videos/sintel-short.mp4`;
const TEARS_MP4 = `${MDN}/shared-assets/videos/tears-of-steel-battle-clip-medium.mp4`;
const FLOWER_MP4 = `${MDN}/shared-assets/videos/flower.mp4`;
const FRIDAY_MP4 = `${MDN}/shared-assets/videos/friday.mp4`;
const RABBIT_MP4 = `${MDN}/learning-area/html/multimedia-and-embedding/video-and-audio-content/rabbit320.mp4`;
const OCEANS_MP4 = 'https://vjs.zencdn.net/v/oceans.mp4';
const BLUE_MOON_MP4 = 'https://cdn.plyr.io/static/demo/View_From_A_Blue_Moon_Trailer-720p.mp4';
const FLOWER_WEBM = `${MDN}/shared-assets/videos/flower.webm`;
const SINTEL_WEBM = `${MDN}/shared-assets/videos/sintel-short.webm`;
const TOFF_WEBM = `${MDN}/shared-assets/videos/tears-of-steel-battle-clip-medium.webm`;

/** 公开 HLS 测试流（Big Buck Bunny 多码率，Mux 演示流） */
export const DEMO_HLS_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

/** 演示分类（顺序即 Tab 顺序；"全部"由 UI 用 null 表示） */
export const DEMO_CATEGORIES: DemoCategorySeed[] = [
  { value: 'movie', name: '电影', order: 0 },
  { value: 'series', name: '电视剧', order: 1 },
  { value: 'anime', name: '动漫', order: 2 },
  { value: 'variety', name: '综艺', order: 3 },
];

function movie(
  itemId: string,
  title: string,
  originalTitle: string | null,
  year: number,
  area: string,
  genres: string[],
  rating: number | null,
  durationSec: number,
  description: string,
  hue: number,
  url: string,
): DemoItemSeed {
  return {
    itemId,
    title,
    originalTitle,
    type: 'movie',
    year,
    area,
    genres,
    tags: ['公开版权', '演示'],
    rating,
    description,
    durationSec,
    hue,
    lines: [
      {
        name: '默认线路',
        quality: '720p',
        format: 'mp4',
        episodes: [{ title: title, durationSec, url }],
      },
    ],
  };
}

function series(
  itemId: string,
  title: string,
  type: MediaType,
  year: number,
  area: string,
  genres: string[],
  description: string,
  hue: number,
  episodes: Array<{ title: string; durationSec: number; url: string }>,
): DemoItemSeed {
  return {
    itemId,
    title,
    originalTitle: null,
    type,
    year,
    area,
    genres,
    tags: ['公开版权', '演示'],
    rating: null,
    description,
    durationSec: null,
    hue,
    lines: [
      {
        name: '默认线路',
        quality: '720p',
        format: 'mp4',
        episodes,
      },
    ],
  };
}

export const DEMO_ITEMS: DemoItemSeed[] = [
  movie(
    'demo-001',
    'Big Buck Bunny',
    'Big Buck Bunny',
    2008,
    '美国',
    ['动画', '喜剧'],
    7.8,
    596,
    '一只温和的大兔子被三只小动物捉弄后展开反击。Blender 基金会开放影片，用于验证 MP4 播放链路。',
    24,
    BBB_MP4,
  ),
  {
    ...movie(
      'demo-002',
      'Sintel',
      'Sintel',
      2010,
      '荷兰',
      ['动画', '奇幻'],
      8.2,
      888,
      '少女为寻找幼龙踏上漫长旅途。Blender 基金会开放影片，含多码率 HLS 线路，用于验证 HLS 通路。',
      200,
      SINTEL_MP4,
    ),
    lines: [
      {
        name: '默认线路',
        quality: '720p',
        format: 'mp4',
        episodes: [{ title: 'Sintel', durationSec: 888, url: SINTEL_MP4 }],
      },
      {
        name: 'HLS 线路',
        quality: '自动',
        format: 'hls',
        episodes: [{ title: 'Sintel（HLS）', durationSec: 888, url: DEMO_HLS_URL }],
      },
    ],
  },
  movie(
    'demo-003',
    'Tears of Steel',
    'Tears of Steel',
    2012,
    '荷兰',
    ['科幻', '动作'],
    7.1,
    734,
    '未来的阿姆斯特丹，人类与机器人之间的冲突一触即发。Blender 基金会开放影片。',
    268,
    TEARS_MP4,
  ),
  movie(
    'demo-004',
    'Elephants Dream',
    'Elephants Dream',
    2006,
    '荷兰',
    ['动画', '实验'],
    6.9,
    160,
    '两个角色在机械世界中探索。Blender 基金会首部开放影片。',
    160,
    OCEANS_MP4,
  ),
  movie(
    'demo-005',
    'For Bigger Blazes',
    'For Bigger Blazes',
    2008,
    '美国',
    ['短片'],
    6.2,
    15,
    '公开示例短片，用于验证短视频起播速度。',
    8,
    FLOWER_MP4,
  ),
  movie(
    'demo-006',
    'For Bigger Escapes',
    'For Bigger Escapes',
    2008,
    '美国',
    ['短片'],
    6.0,
    15,
    '公开示例短片，用于验证码率切换与快进。',
    96,
    FRIDAY_MP4,
  ),
  series(
    'demo-101',
    '四季物语',
    'series',
    2021,
    '中国',
    ['剧情', '治愈'],
    '一部关于四季更替与人情往来的示例剧集，共 3 集，用于验证剧集列表、自动连播与续播。',
    150,
    [
      { title: '第 1 集 · 春', durationSec: 596, url: BBB_MP4 },
      { title: '第 2 集 · 夏', durationSec: 888, url: SINTEL_MP4 },
      { title: '第 3 集 · 秋', durationSec: 734, url: TEARS_MP4 },
    ],
  ),
  series(
    'demo-102',
    '城市漫游',
    'series',
    2022,
    '中国',
    ['纪录'],
    '跟随镜头漫步城市街区的示例剧集，共 4 集，用于验证多集选择与批量下载。',
    212,
    [
      { title: '第 1 集 · 清晨', durationSec: 594, url: BLUE_MOON_MP4 },
      { title: '第 2 集 · 午后', durationSec: 15, url: FRIDAY_MP4 },
      { title: '第 3 集 · 黄昏', durationSec: 15, url: FLOWER_MP4 },
      { title: '第 4 集 · 夜色', durationSec: 15, url: RABBIT_MP4 },
    ],
  ),
  series(
    'demo-201',
    '星轨少女',
    'anime',
    2023,
    '日本',
    ['动画', '科幻'],
    '少女在星轨上寻找失落的记忆，共 3 集，用于验证动漫分类与 HLS 线路切换。',
    320,
    [
      { title: '第 1 集 · 启程', durationSec: 734, url: TEARS_MP4 },
      { title: '第 2 集 · 迷航', durationSec: 160, url: OCEANS_MP4 },
      { title: '第 3 集 · 归途', durationSec: 596, url: BBB_MP4 },
    ],
  ),
  series(
    'demo-202',
    '云端旅人',
    'anime',
    2024,
    '日本',
    ['动画', '冒险'],
    '以云海为舞台的冒险故事，共 3 集，用于验证年份/地区筛选。',
    186,
    [
      { title: '第 1 集 · 出航', durationSec: 888, url: SINTEL_MP4 },
      { title: '第 2 集 · 风暴', durationSec: 734, url: TEARS_MP4 },
      { title: '第 3 集 · 彼岸', durationSec: 596, url: BBB_MP4 },
    ],
  ),
  series(
    'demo-301',
    '厨房时间',
    'variety',
    2024,
    '中国',
    ['真人秀', '美食'],
    '轻松的美食综艺示例，共 3 集，用于验证综艺类型与时长展示。',
    40,
    [
      { title: '第 1 集 · 早餐', durationSec: 15, url: FLOWER_MP4 },
      { title: '第 2 集 · 午餐', durationSec: 15, url: FRIDAY_MP4 },
      { title: '第 3 集 · 晚餐', durationSec: 15, url: RABBIT_MP4 },
    ],
  ),
  series(
    'demo-302',
    '户外实验室',
    'variety',
    2023,
    '中国',
    ['真人秀', '户外'],
    '把实验搬到大自然的示例综艺，共 3 集，用于验证筛选与搜索。',
    112,
    [
      { title: '第 1 集 · 山谷', durationSec: 15, url: FLOWER_WEBM },
      { title: '第 2 集 · 海岸', durationSec: 15, url: SINTEL_WEBM },
      { title: '第 3 集 · 荒原', durationSec: 484, url: TOFF_WEBM },
    ],
  ),
];

/** 演示条目总数（供断言与 UI 文案用） */
export const DEMO_ITEM_COUNT = DEMO_ITEMS.length;

/* ---------- 海报（内联 SVG） ---------- */

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

/** 生成 2:3 海报的 data URL（无网络依赖，离线可渲染） */
export function demoPoster(title: string, hue: number): string {
  const safe = escapeXml(title);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 46% 28%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 32) % 360} 40% 12%)"/>
    </linearGradient>
  </defs>
  <rect width="300" height="450" fill="url(#g)"/>
  <circle cx="246" cy="70" r="92" fill="hsl(${hue} 62% 62%)" opacity="0.18"/>
  <rect x="24" y="24" width="62" height="22" rx="11" fill="hsl(${hue} 70% 70%)" opacity="0.22"/>
  <text x="36" y="40" fill="#f4f4f5" font-family="system-ui, sans-serif" font-size="12">DEMO</text>
  <text x="24" y="382" fill="#f4f4f5" font-family="system-ui, sans-serif" font-size="26" font-weight="600">${safe}</text>
  <text x="24" y="412" fill="#b4b4bd" font-family="system-ui, sans-serif" font-size="13">PUBLIC DOMAIN SAMPLE</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 生成 16:9 横版背景图（详情页头部） */
export function demoBackdrop(title: string, hue: number): string {
  const safe = escapeXml(title);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs>
    <linearGradient id="b" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 44% 26%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 40) % 360} 38% 10%)"/>
    </linearGradient>
  </defs>
  <rect width="640" height="360" fill="url(#b)"/>
  <circle cx="520" cy="96" r="140" fill="hsl(${hue} 62% 64%)" opacity="0.14"/>
  <text x="32" y="322" fill="#f4f4f5" font-family="system-ui, sans-serif" font-size="30" font-weight="600">${safe}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 按 itemId 查找片单 */
export function findDemoItem(itemId: string): DemoItemSeed | null {
  return DEMO_ITEMS.find((item) => item.itemId === itemId) ?? null;
}
