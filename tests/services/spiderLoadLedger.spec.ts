/**
 * 确定性爬虫加载失败账本单测（P1-2）
 *
 * 覆盖：分类口径（只认必然复现的失败，高波动与保护态一律不记）、
 * 版本/运行时作用域、同源重复记账不膨胀、复检清理、跳过判定。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { APP_VERSION } from '@/shared/constants';
import {
  classifyDeterministicLoadFailure,
  clearLoadFailure,
  fingerprintOf,
  findSuppressedLoadFailure,
  listLoadFailures,
  noteLoadFailure,
  sourceLedgerKey,
} from '@/services/spiderLoadLedger';

import { resetAll } from '../unit/helpers';

const JAR = 'https://example.com/guard.jar;md5;abc123';
const RULE = 'https://example.com/libs/open.js';

function source(overrides: Record<string, string> = {}) {
  return { id: 's1', key: 'xbpq', baseUrl: 'https://xb.example.com', ...overrides };
}

describe('classifyDeterministicLoadFailure', () => {
  it('把 jar 与运行时不兼容判成确定性失败', () => {
    // 真机实测：坏 jar 抛 IncompatibleClassChangeError，解除隔离也救不活
    expect(classifyDeterministicLoadFailure('java.lang.IncompatibleClassChangeError: csp_PanWebShare')).toBe(
      'class_incompatible',
    );
    expect(classifyDeterministicLoadFailure('java.lang.ClassNotFoundException: com.github.catvod.csp.XY')).toBe(
      'class_incompatible',
    );
    expect(classifyDeterministicLoadFailure('NoClassDefFoundError: okhttp3/OkHttpClient')).toBe(
      'class_incompatible',
    );
    expect(classifyDeterministicLoadFailure('java.lang.NoSuchMethodError: search')).toBe('class_incompatible');
    expect(classifyDeterministicLoadFailure('ClassCastException: Integer cannot be cast to String')).toBe(
      'class_incompatible',
    );
  });

  it('把 jar 完整性与脚本语法问题各自归类', () => {
    expect(classifyDeterministicLoadFailure('jar md5 mismatch: expect abc, got def')).toBe('jar_integrity');
    expect(classifyDeterministicLoadFailure('jar too large (214MB)')).toBe('jar_integrity');
    expect(classifyDeterministicLoadFailure("SyntaxError: expecting ';'")).toBe('script_syntax');
    expect(classifyDeterministicLoadFailure("'data' is not defined")).toBe('script_syntax');
  });

  it('jar 地址自带的 ;md5; 后缀不能算完整性故障', () => {
    // 真机的加载失败文案里普遍嵌着 jar 完整地址（`;md5;校验串`），裸匹配 md5
    // 会把「没下载到文件」这类瞬时问题写成源侧确定性故障，好源被永久跳过。
    expect(
      classifyDeterministicLoadFailure(`java.io.FileNotFoundException: ${JAR} (No such file or directory)`),
    ).toBeNull();
    expect(
      classifyDeterministicLoadFailure(`guard 类型爬虫初始化失败（csp_Guard）：打开 ${JAR} 失败`),
    ).toBeNull();
  });

  it('高波动失败与保护态不记账', () => {
    // 这些恰恰是「下次可能就好了」，写死就是把临时不通变永久拉黑
    for (const message of [
      'HTTP 401 Unauthorized',
      'HTTP 503 Service Unavailable',
      'java.net.UnknownHostException: xb.example.com',
      '连接超时 timeout',
      'spider quarantined (crash): spider:440f930e:csp_X',
      'spider cooling down (suspicious crash): spider:440f930e:csp_X',
      'safe mode active',
      '源返回 HTML 页面而非 JSON',
      '源忙，请稍后重试',
    ]) {
      expect(classifyDeterministicLoadFailure(message)).toBeNull();
    }
  });

  it('判不准就不记（宁可多跑一次）', () => {
    expect(classifyDeterministicLoadFailure('爬虫加载失败，请检查网络或更换源')).toBeNull();
    expect(classifyDeterministicLoadFailure('')).toBeNull();
  });
});

describe('spiderLoadLedger 记账与跳过判定', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('记一条之后，同一版本会被判为跳过', async () => {
    await noteLoadFailure(source(), 'class_incompatible', JAR, 'IncompatibleClassChangeError');
    const hit = await findSuppressedLoadFailure(source(), JAR);
    expect(hit?.kind).toBe('class_incompatible');
    expect(hit?.sourceKey).toBe('xbpq');
    expect(hit?.runtime).toBe(APP_VERSION);
  });

  it('订阅换了 jar 版本就不再跳过', async () => {
    await noteLoadFailure(source(), 'class_incompatible', JAR, 'IncompatibleClassChangeError');
    expect(await findSuppressedLoadFailure(source(), 'https://example.com/new.jar')).toBeNull();
  });

  it('App 版本变化后重新给一次机会', async () => {
    await noteLoadFailure(source(), 'class_incompatible', JAR, 'IncompatibleClassChangeError');
    const rows = await listLoadFailures();
    expect(rows).toHaveLength(1);
    // 手工把账本写成"上一个 App 版本"，等价于升级后读到的历史：旧判定对新运行时没有发言权
    await writeLedger([{ ...rows[0], runtime: '0.0.0-not-current' }]);
    expect(await findSuppressedLoadFailure(source(), JAR)).toBeNull();
    expect(await listLoadFailures()).toHaveLength(0);
  });

  it('重复失败只留一条，不同源各记各的', async () => {
    for (let i = 0; i < 5; i++) {
      await noteLoadFailure(source(), 'class_incompatible', JAR, 'IncompatibleClassChangeError');
    }
    await noteLoadFailure(source({ key: 'other' }), 'script_syntax', RULE, "SyntaxError: expecting ';'");
    const rows = await listLoadFailures();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sourceKey).sort()).toEqual(['other', 'xbpq']);
  });

  it('复检清理后恢复预热判定', async () => {
    await noteLoadFailure(source(), 'jar_integrity', JAR, 'jar md5 mismatch');
    expect(await findSuppressedLoadFailure(source(), JAR)).not.toBeNull();
    expect(await clearLoadFailure('xbpq')).toBe(1);
    expect(await findSuppressedLoadFailure(source(), JAR)).toBeNull();
    expect(await listLoadFailures()).toHaveLength(0);
  });

  it('账本键优先用订阅 key，手工源退回根地址', () => {
    expect(sourceLedgerKey({ id: 's1', key: 'xbpq', baseUrl: 'https://xb' })).toBe('xbpq');
    expect(sourceLedgerKey({ id: 's1', key: '  ', baseUrl: 'https://xb' })).toBe('https://xb');
    expect(sourceLedgerKey({ id: 's1', key: '', baseUrl: '' })).toBe('s1');
  });

  it('指纹由源 + 版本 + 运行时三部分组成', () => {
    expect(fingerprintOf({ sourceKey: 'a', target: 'b', runtime: 'c' })).toBe('a|b|c');
  });
});

/** 直接写账本，用来构造"旧 App 版本留下的记录" */
async function writeLedger(rows: unknown[]): Promise<void> {
  const { kvRepo } = await import('@/db/repositories/kvRepo');
  await kvRepo.set('spider_load_failures', rows);
}
