/**
 * 内置推荐订阅清单加载器（v1.7 / CHG-24，FR-56）
 *
 * 清单随版本分发（`recommended.json`），无云端更新——用户仍可自行粘贴任意订阅。
 * 红线（收窄后的 FR-46）：不含成人内容、设置可整体关闭、只评测展示、导入需用户逐项确认。
 * 加载时做 schema + 敏感词校验（AC-130），不合格条目静默剔除。
 */
import raw from '@/data/recommended/recommended.json';
import { RECOMMENDED_SUBSCRIPTIONS_VERSION } from '@/shared/constants';

export interface RecommendedSubscription {
  name: string;
  url: string;
  note: string;
  tags: string[];
}

export interface RecommendedManifest {
  version: number;
  updatedAt: string;
  note: string;
  items: RecommendedSubscription[];
}

/**
 * 敏感词（与 subscriptionParser 同源口径 + 成人标记）；命中即剔除。
 *
 * 只匹配「名称 + 备注」这类人工文案，不对 URL 做敏感词判定：
 * 域名可能天然带 `vip` 等词（如 `*.kstore.vip`），按 URL 匹配会误杀真实可用源
 * （Q-01 / FIX-02）。URL 的合法性由下方 `http(s)` 协议校验负责。
 */
const FORBIDDEN = /破解|盗版|18\+|成人|r18|nsfw|vip|付费|会员/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateItem(value: unknown): RecommendedSubscription | null {
  if (!isRecord(value)) return null;
  const name = typeof value['name'] === 'string' ? value['name'].trim() : '';
  const url = typeof value['url'] === 'string' ? value['url'].trim() : '';
  const note = typeof value['note'] === 'string' ? value['note'].trim() : '';
  const tags = Array.isArray(value['tags']) ? value['tags'].filter((t): t is string => typeof t === 'string') : [];
  if (name.length === 0 || url.length === 0) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  // Q-01：只对人工文案做敏感词判定，URL 不参与（避免域名含 vip 等词被误杀）
  if (FORBIDDEN.test(`${name} ${note}`)) return null;
  return { name, url, note, tags };
}

let cached: RecommendedManifest | null = null;

/** 校验并返回清单（模块级缓存；结果确定性） */
export function recommendedSubscriptions(): RecommendedManifest {
  if (cached) return cached;
  const source = raw as unknown;
  const items = isRecord(source) && Array.isArray(source['items'])
    ? (source['items'] as unknown[]).map(validateItem).filter((item): item is RecommendedSubscription => item !== null)
    : [];
  cached = {
    version: isRecord(source) && typeof source['version'] === 'number' ? source['version'] : RECOMMENDED_SUBSCRIPTIONS_VERSION,
    updatedAt: isRecord(source) && typeof source['updatedAt'] === 'string' ? source['updatedAt'] : '',
    note: isRecord(source) && typeof source['note'] === 'string' ? source['note'] : '',
    items,
  };
  return cached;
}

/** 单测辅助：清缓存 */
export function resetRecommendedCache(): void {
  cached = null;
}
