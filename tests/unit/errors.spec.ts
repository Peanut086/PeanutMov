import { describe, expect, it } from 'vitest';

import { AppError, ERROR_MESSAGES, RETRYABLE_CODES, toAppError, toErrorShape } from '@/shared/errors';
import type { ErrorCode } from '@/types';

/**
 * 错误码 → 用户文案（AC-60 / REV-04）
 *
 * AC-60 原文要求：
 * - `E_NOT_FOUND → "资源不存在(404)"`
 * - `E_DRM_PROTECTED → "不支持受保护内容"`
 * - `E_UNSUPPORTED_FORMAT → "暂不支持该格式"`
 * - 未知码回退 "播放失败，请重试"
 */

/** `ErrorCode` 全枚举（类型联合无法运行期遍历，这里显式列出并要求与类型同步） */
const ALL_ERROR_CODES = [
  'E_UNKNOWN',
  'E_NETWORK',
  'E_TIMEOUT',
  'E_ABORTED',
  'E_HTTP_400',
  'E_HTTP_401',
  'E_HTTP_403',
  'E_HTTP_404',
  'E_HTTP_429',
  'E_HTTP_5XX',
  'E_AUTH',
  'E_PARSE',
  'E_INVALID_INPUT',
  'E_NOT_FOUND',
  'E_NOT_IMPLEMENTED',
  'E_SOURCE_DISABLED',
  'E_SOURCE_UNAVAILABLE',
  'E_NO_PLAY_URL',
  'E_NETDISK_LOGIN_REQUIRED',
  'E_UNSUPPORTED_FORMAT',
  'E_DRM_PROTECTED',
  'E_DECODE',
  'E_INVALID_STATE',
  'E_STORAGE_QUOTA',
  'E_FILE_MISSING',
  'E_DB',
  'E_VERSION_UNSUPPORTED',
  'E_CANCELED',
] as const satisfies readonly ErrorCode[];

describe('AC-60 错误码 → 用户文案映射', () => {
  it('遍历 ErrorCode 全枚举：每项都有映射且非空', () => {
    expect(ALL_ERROR_CODES).toHaveLength(28);
    for (const code of ALL_ERROR_CODES) {
      const text = ERROR_MESSAGES[code];
      expect(text, `${code} 缺少映射`).toBeTypeOf('string');
      expect(text.trim().length, `${code} 文案为空`).toBeGreaterThan(0);
    }
    // 表里不应有枚举外的多余键
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...ALL_ERROR_CODES].sort());
  });

  it('AC-60 指定四条映射逐条成立', () => {
    expect(ERROR_MESSAGES.E_NOT_FOUND).toBe('资源不存在(404)');
    expect(ERROR_MESSAGES.E_DRM_PROTECTED).toBe('不支持受保护内容');
    expect(ERROR_MESSAGES.E_UNSUPPORTED_FORMAT).toBe('暂不支持该格式');
    // 未知码回退（AppError 缺省 message 即取该表）
    const unknown = new AppError('E_UNKNOWN');
    expect(unknown.message).toBe('操作失败，请重试');
    expect(toErrorShape(new Error('boom'), 'E_UNKNOWN').message).toBe('操作失败，请重试');
  });

  it('映射表全量快照（防后续改动无回归保护）', () => {
    expect(ERROR_MESSAGES).toMatchObject({
      E_UNKNOWN: '操作失败，请重试',
      E_NETWORK: '网络不可用，请检查网络后重试',
      E_TIMEOUT: '请求超时，请稍后重试',
      E_ABORTED: '已取消',
      E_HTTP_400: '请求参数有误(400)',
      E_HTTP_401: '认证失败，请检查账号或 Token',
      E_HTTP_403: '无权限访问(403)',
      E_HTTP_404: '资源不存在(404)',
      E_HTTP_429: '请求过于频繁，请稍后再试',
      E_HTTP_5XX: '服务器异常，请稍后重试',
      E_AUTH: '认证失败，请检查账号或 Token',
      E_PARSE: '数据解析失败，源可能已变更',
      E_INVALID_INPUT: '输入内容不合法，请检查后重试',
      E_NOT_FOUND: '资源不存在(404)',
      E_NOT_IMPLEMENTED: '该源不支持此操作',
      E_SOURCE_DISABLED: '该源已禁用，请先在源管理中启用',
      E_SOURCE_UNAVAILABLE: '该源暂不可用，可切换其他源',
      E_NO_PLAY_URL: '该集暂无可播放地址',
      E_NETDISK_LOGIN_REQUIRED: '网盘未登录，请先登录',
      E_UNSUPPORTED_FORMAT: '暂不支持该格式',
      E_DRM_PROTECTED: '不支持受保护内容',
      E_DECODE: '视频解码失败，请尝试切换线路',
      E_INVALID_STATE: '当前状态不允许该操作',
      E_STORAGE_QUOTA: '存储空间不足',
      E_FILE_MISSING: '本地文件不可用，请重新下载',
      E_DB: '本地数据读写失败，请重试',
      E_VERSION_UNSUPPORTED: '数据版本不支持，请升级 App',
      E_CANCELED: '已取消',
    });
  });

  it('AppError 缺省文案、自定义文案与可重试性判定一致', () => {
    for (const code of ALL_ERROR_CODES) {
      const error = new AppError(code);
      expect(error.message).toBe(ERROR_MESSAGES[code]);
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(RETRYABLE_CODES.has(code));
    }
    expect(new AppError('E_DB', '自定义文案').message).toBe('自定义文案');
  });

  it('toAppError：已是 AppError 原样透传；AbortError → E_ABORTED；配额 → E_STORAGE_QUOTA', () => {
    const original = new AppError('E_NO_PLAY_URL');
    expect(toAppError(original)).toBe(original);

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(toAppError(abort).code).toBe('E_ABORTED');

    const quota = new Error('quota');
    quota.name = 'QuotaExceededError';
    expect(toAppError(quota).code).toBe('E_STORAGE_QUOTA');
    expect(toAppError(quota).message).toBe(ERROR_MESSAGES.E_STORAGE_QUOTA);
  });

  it('鉴权类错误码不可重试（AC-39 / REV-16：403 重试无意义）', () => {
    expect(RETRYABLE_CODES.has('E_HTTP_403')).toBe(false);
    expect(RETRYABLE_CODES.has('E_AUTH')).toBe(false);
    expect(RETRYABLE_CODES.has('E_HTTP_401')).toBe(false);
    expect(new AppError('E_HTTP_403').retryable).toBe(false);
    expect(new AppError('E_AUTH').retryable).toBe(false);
    // 403 保留"无权限访问"文案，不被 401 的认证文案覆盖
    expect(ERROR_MESSAGES.E_HTTP_403).toBe('无权限访问(403)');
    expect(new AppError('E_HTTP_403').message).not.toBe(ERROR_MESSAGES.E_AUTH);
  });
});
