/**
 * OPT-07：搜索建议服务
 *
 * 轻量级本地建议源：
 * 1. 搜索历史（优先匹配）
 * 2. 本地媒体库标题（模糊匹配）
 * 3. 热门搜索（内置固定清单）
 *
 * 设计原则：
 * - 纯本地计算，无网络请求
 * - 响应时间 < 16ms（单帧内完成）
 * - 返回结果去重、按相关度排序
 *
 * REV-14：服务函数不再直接耦合 Pinia store，由调用方传入数据。
 */

export interface SearchSuggestion {
  text: string;
  source: 'history' | 'library' | 'hot';
  highlight?: string; // 高亮片段（匹配关键词）
}

/** 热门搜索清单（P2：换成真实中文热搜词，替代旧版演示内容） */
const HOT_SEARCH_LIST: readonly string[] = [
  '流浪地球',
  '三体',
  '庆余年',
  '与凤行',
  '繁花',
  '漫长的季节',
  '狂飙',
  '满江红',
  '流浪地球2',
  '长相思',
];

/**
 * 获取搜索建议
 * @param keyword 输入关键词
 * @param limit 最大返回数量（默认 8）
 * @param historyItems 搜索历史列表（由调用方传入，解耦 store 依赖）
 * @param libraryItems 本地媒体库列表（由调用方传入，解耦 store 依赖）
 */
export function getSearchSuggestions(
  keyword: string,
  limit = 8,
  historyItems: string[] = [],
  libraryItems: Array<{ title?: string }> = [],
): SearchSuggestion[] {
  const kw = keyword.trim().toLowerCase();
  if (kw.length === 0) return [];

  const suggestions: SearchSuggestion[] = [];
  const seen = new Set<string>();

  // 1. 搜索历史匹配（最高优先级）
  for (const item of historyItems) {
    if (suggestions.length >= limit) break;
    const lower = item.toLowerCase();
    if (lower.includes(kw)) {
      const key = item.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        suggestions.push({
          text: item,
          source: 'history',
          highlight: extractHighlight(item, kw),
        });
      }
    }
  }

  // 2. 本地媒体库标题匹配（仅搜索已加载的条目）
  for (const media of libraryItems) {
    if (suggestions.length >= limit) break;
    const title = media.title ?? '';
    const lower = title.toLowerCase();
    if (lower.includes(kw) && title.length > 0) {
      const key = title.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        suggestions.push({
          text: title,
          source: 'library',
          highlight: extractHighlight(title, kw),
        });
      }
    }
  }

  // 3. 热门搜索匹配（兜底）
  if (suggestions.length < limit) {
    for (const hot of HOT_SEARCH_LIST) {
      if (suggestions.length >= limit) break;
      const lower = hot.toLowerCase();
      if (lower.includes(kw)) {
        const key = hot.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          suggestions.push({
            text: hot,
            source: 'hot',
            highlight: extractHighlight(hot, kw),
          });
        }
      }
    }
  }

  return suggestions.slice(0, limit);
}

/**
 * 获取热门搜索标签（用于初始页展示）
 */
export function getHotSearchTags(limit = 10): string[] {
  return HOT_SEARCH_LIST.slice(0, limit);
}

/**
 * 提取高亮片段（简单实现：返回匹配的子串位置）
 */
function extractHighlight(text: string, keyword: string): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(keyword);
  if (idx === -1) return text;
  return text.slice(idx, idx + keyword.length);
}
