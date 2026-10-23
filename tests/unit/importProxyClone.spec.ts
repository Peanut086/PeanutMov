import { beforeEach, describe, expect, it } from 'vitest';
import { reactive } from 'vue';

import { importService } from '@/services/importService';
import { subscriptionParser } from '@/services/subscriptionParser';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { resetAll } from './helpers';

/**
 * 回归：预览对象来自 Vue 响应式状态时，`ext` 会被包成 Proxy，
 * IndexedDB 结构化克隆抛 DataCloneError（表现为「本地数据读写失败」）。
 * 带 ext 的爬虫源在导入时首次暴露该问题（站点源的 ext 多为 null）。
 */
describe('导入：响应式 Proxy 数据的可克隆性', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('reactive 包装的 preview 也能成功写入（ext 不再是裸 Proxy）', async () => {
    const preview = subscriptionParser.parse(
      JSON.stringify({
        sites: [
          {
            key: 'csp_XBPQ',
            name: '爬虫源',
            type: 3,
            api: 'csp_XBPQ',
            jar: 'https://example.com/1.jar',
            ext: { 分类url: 'https://example.com/vod-show/{cateId}.html' },
          },
          { key: 'cms', name: '站点源', type: 1, api: 'https://cms.example.com/api.php/provide/vod/' },
        ],
      }),
      { origin: 'url', sourceUrl: 'https://example.com/sub.json' },
    );
    expect(preview.entries.every((entry) => entry.valid)).toBe(true);

    // 关键：与 UI 一致，preview 放在响应式容器里
    const state = reactive({ preview });
    const result = await importService.commit(state.preview, { selectedKeys: [], onDuplicate: 'skip' });

    expect(result.success).toBe(2);
    expect(result.failed).toBe(0);

    const saved = await sourceRepo.list();
    const spider = saved.find((source) => source.type === 'spider');
    expect(spider?.ext).toMatchObject({ kind: 'jar', api: 'csp_XBPQ' });
  });

  it('大批量爬虫源（多源共用同一 jar）可整批导入', async () => {
    // 形态对齐真实订阅 xhztv.top/4k.json：多个 spider 源共用同一个 jar 地址，
    // ext 含中文 key、长 initExt（TVBox key:value 纯文本）与 JSON 对象两种形态。
    const jars = [
      'https://jihulab.com/xiaohutx/meisha/-/raw/main/1.jar;md5;bb155c3f0133bbce4756ad52003f5968',
      'http://rihou.vip:55/lib/ttkx.jar;md5;c253e1930a210fa5141e5418f1f90949',
      'https://agit.ai/guot54/ygbh/raw/branch/master/JAR/83.jar',
    ];
    const spiders = Array.from({ length: 40 }, (_, i) => ({
      key: `csp_Spider${i}`,
      name: `爬虫源 ${i}`,
      type: 3,
      api: 'csp_XBPQ',
      jar: jars[i % jars.length]!,
      ext: i % 2 === 0 ? '分类url:http://a.com/vod/{cateId}.html,分类:电影&剧集' : { 分类url: 'http://b.com/{cateId}.html' },
    }));
    const sites = Array.from({ length: 9 }, (_, i) => ({
      key: `cms${i}`,
      name: `站点源 ${i}`,
      type: 1,
      api: `https://cms${i}.example.com/api.php/provide/vod/`,
    }));

    const preview = subscriptionParser.parse(
      JSON.stringify({ spider: jars[1], sites: [...spiders, ...sites] }),
      { origin: 'url' },
    );
    const state = reactive({ preview });

    const result = await importService.commit(state.preview, { selectedKeys: [], onDuplicate: 'skip' });
    expect(result.failed).toBe(0);
    expect(result.success).toBe(49);

    const saved = await sourceRepo.list();
    expect(saved.filter((s) => s.type === 'spider')).toHaveLength(40);
    expect(saved.filter((s) => s.type === 'site')).toHaveLength(9);
  });
});
