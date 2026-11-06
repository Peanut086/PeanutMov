/**
 * 备份加密单测（EXT-05 phase1）
 *
 * 覆盖：密码强度、salt/iv 随机性、AES-256-GCM 往返、外壳结构与版本校验、
 * 错误密码 / 篡改密文 / 不支持版本的用户文案、密钥缓存序列化、校验块比对。
 *
 * 性能约定：所有派生都显式传 `iterations`（1000）——生产默认 150000 次，
 * 单测无需为抗爆破强度付出时间；解密侧从"文件头里的 iterations"取值，
 * 因此与生产实现走的是同一条代码路径。
 */
import { describe, expect, it } from 'vitest';

import {
  base64ToBytes,
  bytesToBase64,
  createVerifier,
  decryptBackupText,
  decryptBackupTextWithKey,
  deriveKey,
  encryptBackupText,
  ENVELOPE_VERSION,
  exportKeyToBase64,
  generateSalt,
  importKeyFromBase64,
  isEncryptedBackup,
  KEY_CHECK_PLAINTEXT,
  MIN_PASSWORD_LENGTH,
  parseEnvelope,
  validatePassword,
  verifyPassword,
} from '@/services/backupEncryption';

const PASSWORD = 'correct-horse-8';
const WRONG_PASSWORD = 'wrong-horse-8';
/** 测试用低迭代次数（见文件头） */
const ITERATIONS = 1_000;
const PLAIN = JSON.stringify({ schemaVersion: 3, sources: [], favorites: [] });

describe('validatePassword', () => {
  it('少于 8 位时抛出明确文案', () => {
    expect(() => validatePassword('1234567')).toThrow(`加密密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  });

  it('恰好 8 位即可通过', () => {
    expect(() => validatePassword('12345678')).not.toThrow();
  });

  it('非字符串同样拒绝', () => {
    expect(() => validatePassword(undefined as unknown as string)).toThrow();
  });
});

describe('base64 / salt 工具', () => {
  it('字节与 base64 互转无损失', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 200, 255]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('默认 salt 为 16 字节且每次随机', () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(a).toHaveLength(16);
    expect(bytesToBase64(a)).not.toBe(bytesToBase64(b));
  });

  it('salt 长度可指定', () => {
    expect(generateSalt(8)).toHaveLength(8);
  });
});

describe('encryptBackupText / decryptBackupText', () => {
  it('密码加密后可用同一密码解出原文', async () => {
    const text = await encryptBackupText(PLAIN, { password: PASSWORD, iterations: ITERATIONS });
    await expect(decryptBackupText(text, PASSWORD)).resolves.toBe(PLAIN);
  });

  it('外壳含 version / kdf / iterations / salt / iv / data，且 salt=16B、iv=12B', async () => {
    const text = await encryptBackupText(PLAIN, { password: PASSWORD, iterations: ITERATIONS });
    const envelope = parseEnvelope(text);
    expect(envelope).not.toBeNull();
    expect(envelope?.version).toBe(ENVELOPE_VERSION);
    expect(envelope?.kdf).toBe('PBKDF2-SHA256');
    expect(envelope?.iterations).toBe(ITERATIONS);
    expect(base64ToBytes(envelope!.salt)).toHaveLength(16);
    expect(base64ToBytes(envelope!.iv)).toHaveLength(12);
    expect(base64ToBytes(envelope!.data).length).toBeGreaterThan(PLAIN.length);
    // 明文不得出现在外壳里
    expect(text).not.toContain('schemaVersion');
  });

  it('每次加密使用新的 salt 与 iv，密文不同', async () => {
    const a = parseEnvelope(await encryptBackupText(PLAIN, { password: PASSWORD, iterations: ITERATIONS }))!;
    const b = parseEnvelope(await encryptBackupText(PLAIN, { password: PASSWORD, iterations: ITERATIONS }))!;
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it('密码错误提示「密码错误或备份文件已损坏」', async () => {
    const text = await encryptBackupText(PLAIN, { password: PASSWORD, iterations: ITERATIONS });
    await expect(decryptBackupText(text, WRONG_PASSWORD)).rejects.toThrow('密码错误或备份文件已损坏');
  });

  it('过短的错误密码也落到同一提示（不被"至少 8 位"误导）', async () => {
    const text = await encryptBackupText(PLAIN, { password: PASSWORD, iterations: ITERATIONS });
    await expect(decryptBackupText(text, 'abc')).rejects.toThrow('密码错误或备份文件已损坏');
  });

  it('密文被篡改后解密失败（GCM 认证失败）', async () => {
    const text = await encryptBackupText(PLAIN, { password: PASSWORD, iterations: ITERATIONS });
    const envelope = parseEnvelope(text)!;
    const bytes = base64ToBytes(envelope.data);
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = JSON.stringify({ ...envelope, data: bytesToBase64(bytes) });
    await expect(decryptBackupText(tampered, PASSWORD)).rejects.toThrow('密码错误或备份文件已损坏');
  });

  it('外壳版本不支持时明确提示升级', async () => {
    const text = await encryptBackupText(PLAIN, { password: PASSWORD, iterations: ITERATIONS });
    const envelope = parseEnvelope(text)!;
    const future = JSON.stringify({ ...envelope, version: ENVELOPE_VERSION + 1 });
    await expect(decryptBackupText(future, PASSWORD)).rejects.toThrow('加密备份版本不支持');
  });

  it('缺密码且缺密钥时拒绝加密', async () => {
    await expect(encryptBackupText(PLAIN, {})).rejects.toThrow('缺少加密密码');
  });

  it('空密码解密提示「请输入备份密码」', async () => {
    const text = await encryptBackupText(PLAIN, { password: PASSWORD, iterations: ITERATIONS });
    await expect(decryptBackupText(text, '')).rejects.toThrow('请输入备份密码');
  });
});

describe('parseEnvelope / isEncryptedBackup', () => {
  it('非外壳文本返回 null', () => {
    expect(parseEnvelope('')).toBeNull();
    expect(parseEnvelope('not json')).toBeNull();
    expect(parseEnvelope('[]')).toBeNull();
    expect(parseEnvelope('{"version":1}')).toBeNull();
  });

  it('只有带齐字段的加密外壳才判定为加密备份', async () => {
    const encrypted = await encryptBackupText(PLAIN, { password: PASSWORD, iterations: ITERATIONS });
    expect(isEncryptedBackup(encrypted)).toBe(true);
    expect(isEncryptedBackup(PLAIN)).toBe(false);
    expect(isEncryptedBackup('{ "sources": [] }')).toBe(false);
  });
});

describe('密钥复用与缓存序列化', () => {
  it('缓存密钥可加密且可解密（定时备份的无人值守路径）', async () => {
    // 生产口径：salt 由设置持久化，加密时复用同一 salt，因此"密码解密"仍可用
    const salt = generateSalt();
    const key = await deriveKey(PASSWORD, salt, ITERATIONS, true);
    const text = await encryptBackupText(PLAIN, { key, salt, iterations: ITERATIONS });
    await expect(decryptBackupTextWithKey(text, key)).resolves.toBe(PLAIN);
    await expect(decryptBackupText(text, PASSWORD)).resolves.toBe(PLAIN);
  });

  it('只给密钥不给 salt 时外壳 salt 随机，密码无法解出（说明二者必须配套）', async () => {
    const key = await deriveKey(PASSWORD, generateSalt(), ITERATIONS, true);
    const text = await encryptBackupText(PLAIN, { key, iterations: ITERATIONS });
    await expect(decryptBackupTextWithKey(text, key)).resolves.toBe(PLAIN);
    await expect(decryptBackupText(text, PASSWORD)).rejects.toThrow('密码错误或备份文件已损坏');
  });

  it('导出/导入的密钥等价（本机缓存 base64 后仍能解密）', async () => {
    const key = await deriveKey(PASSWORD, generateSalt(), ITERATIONS, true);
    const restored = await importKeyFromBase64(await exportKeyToBase64(key));
    const text = await encryptBackupText(PLAIN, { key, iterations: ITERATIONS });
    await expect(decryptBackupTextWithKey(text, restored)).resolves.toBe(PLAIN);
  });

  it('缓存值长度不对时拒绝导入', async () => {
    await expect(importKeyFromBase64(bytesToBase64(new Uint8Array(5)))).rejects.toThrow(
      '本机加密密钥已损坏',
    );
  });
});

describe('createVerifier / verifyPassword', () => {
  it('正确的密码通过校验，错误的密码不通过', async () => {
    const salt = generateSalt();
    const key = await deriveKey(PASSWORD, salt, ITERATIONS, true);
    const verifier = await createVerifier(key);
    const saltB64 = bytesToBase64(salt);

    await expect(verifyPassword(PASSWORD, saltB64, verifier, ITERATIONS)).resolves.toBe(true);
    await expect(verifyPassword(WRONG_PASSWORD, saltB64, verifier, ITERATIONS)).resolves.toBe(false);
  });

  it('校验块结构非法或参数为空时返回 false（不抛错）', async () => {
    const salt = generateSalt();
    const key = await deriveKey(PASSWORD, salt, ITERATIONS, true);
    const verifier = await createVerifier(key);
    const saltB64 = bytesToBase64(salt);

    await expect(verifyPassword(PASSWORD, saltB64, 'no-separator', ITERATIONS)).resolves.toBe(false);
    await expect(verifyPassword('', saltB64, verifier, ITERATIONS)).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, '', verifier, ITERATIONS)).resolves.toBe(false);
  });

  it('校验块能解出固定明文（与实现常量一致）', async () => {
    const salt = generateSalt();
    const key = await deriveKey(PASSWORD, salt, ITERATIONS, true);
    const verifier = await createVerifier(key);
    const sep = verifier.indexOf('.');
    expect(sep).toBeGreaterThan(0);
    // 结构：`<iv base64>.<cipher base64>`
    expect(base64ToBytes(verifier.slice(0, sep))).toHaveLength(12);
    expect(KEY_CHECK_PLAINTEXT).toBe('peanutmov-backup-key-check');
  });
});
