import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearBuffer, getBuffer, installConsoleCapture } from '@/shared/logBus';

describe('logBus', () => {
  beforeEach(() => {
    clearBuffer();
    installConsoleCapture();
  });

  afterEach(() => {
    clearBuffer();
  });

  it('捕获 console.debug', () => {
    console.debug('test debug');
    const buffer = getBuffer();
    expect(buffer.length).toBeGreaterThan(0);
    const last = buffer[buffer.length - 1];
    expect(last.level).toBe('D');
    expect(last.message).toContain('test debug');
  });

  it('捕获 console.info', () => {
    console.info('test info');
    const buffer = getBuffer();
    const last = buffer[buffer.length - 1];
    expect(last.level).toBe('I');
    expect(last.message).toContain('test info');
  });

  it('捕获 console.warn', () => {
    console.warn('test warn');
    const buffer = getBuffer();
    const last = buffer[buffer.length - 1];
    expect(last.level).toBe('W');
    expect(last.message).toContain('test warn');
  });

  it('捕获 console.error', () => {
    console.error('test error');
    const buffer = getBuffer();
    const last = buffer[buffer.length - 1];
    expect(last.level).toBe('E');
    expect(last.message).toContain('test error');
  });

  it('解析 [scope] 前缀为 tag', () => {
    console.info('[player]', 'hello');
    const buffer = getBuffer();
    const last = buffer[buffer.length - 1];
    expect(last.tag).toBe('player');
    expect(last.message).toContain('hello');
  });

  it('脱敏 URL 中的 token', () => {
    console.info('http://example.com?token=secret123');
    const buffer = getBuffer();
    const last = buffer[buffer.length - 1];
    expect(last.message).toContain('token=***');
    expect(last.message).not.toContain('secret123');
  });

  it('脱敏对象中的 password 字段', () => {
    console.info('config', { password: 'mypwd', user: 'admin' });
    const buffer = getBuffer();
    const last = buffer[buffer.length - 1];
    expect(last.message).toContain('password');
    expect(last.message).toContain('***');
    expect(last.message).not.toContain('mypwd');
  });

  it('环形缓冲限制 2000 条', () => {
    for (let i = 0; i < 2500; i++) {
      console.info('msg ' + i);
    }
    const buffer = getBuffer();
    expect(buffer.length).toBeLessThanOrEqual(2000);
  });

  it('clearBuffer 清空缓冲', () => {
    console.info('test');
    expect(getBuffer().length).toBeGreaterThan(0);
    clearBuffer();
    expect(getBuffer().length).toBe(0);
  });

  it('Error 对象序列化为堆栈', () => {
    const err = new Error('test error');
    console.error(err);
    const buffer = getBuffer();
    const last = buffer[buffer.length - 1];
    expect(last.message).toContain('Error');
    expect(last.message).toContain('test error');
  });
});
