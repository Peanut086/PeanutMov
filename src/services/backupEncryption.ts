/**
 * 备份加密（EXT-05 phase1）
 *
 * 算法：AES-256-GCM（`crypto.subtle`）+ PBKDF2-SHA256 派生密钥。
 * 文件外壳（JSON，扩展名 `.enc`）：
 *
 * ```json
 * { "version": 1, "kdf": "PBKDF2-SHA256", "iterations": 150000,
 *   "salt": "<base64>", "iv": "<base64>", "data": "<base64>" }
 * ```
 *
 * 约定：
 * - `salt` 每条文件独立随机（16B），`iv` 每次加密独立随机（12B，GCM 标准长度）；
 * - 解密只依赖 `密码 + 文件内 salt/iterations`，因此备份可跨设备恢复；
 * - 本模块**不读写设置/存储**，只做纯计算（便于单测）；密钥缓存与设置落盘在 `backupService`。
 */
import { AppError } from '@/shared/errors';

/** 外壳版本；解密时强校验，未知版本直接拒绝 */
export const ENVELOPE_VERSION = 1;
/** PBKDF2 迭代次数（移动端实测约 100~300ms，兼顾抗爆破与可用性） */
export const PBKDF2_ITERATIONS = 150_000;
/** 加密密码最小长度 */
export const MIN_PASSWORD_LENGTH = 8;
/** 校验块明文（固定串，用来判断"用户输入的密码"是否与已保存的派生密钥一致） */
export const KEY_CHECK_PLAINTEXT = 'peanutmov-backup-key-check';

const SALT_BYTES = 16;
const IV_BYTES = 12;
const GCM_TAG_BITS = 128;

export interface BackupEnvelope {
  version: number;
  salt: string;
  iv: string;
  data: string;
  kdf?: 'PBKDF2-SHA256';
  iterations?: number;
}

export interface EncryptOptions {
  /** 密码（内部按 salt 派生密钥） */
  password?: string;
  /** 已派生的密钥（定时备份用缓存密钥，避免每轮重新 PBKDF2） */
  key?: CryptoKey;
  /** 复用已保存的 salt（保持同一密码在不同文件间共享 salt，便于校验块比对） */
  salt?: Uint8Array;
  iterations?: number;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new AppError('E_INVALID_STATE', '当前环境不支持加密（缺少 Web Crypto）');
  }
  return c.subtle;
}

function randomBytes(length: number): Uint8Array {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new AppError('E_INVALID_STATE', '当前环境不支持安全随机数');
  }
  const bytes = new Uint8Array(length);
  c.getRandomValues(bytes);
  return bytes;
}

/** 校验密码强度（≥ 8 位） */
export function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AppError('E_INVALID_INPUT', `加密密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
}

/** 生成随机 salt（默认 16 字节） */
export function generateSalt(length: number = SALT_BYTES): Uint8Array {
  return randomBytes(length);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * PBKDF2(password, salt) → AES-256-GCM CryptoKey。
 *
 * 默认 `extractable=false`（密钥不可导出）；需要缓存到本机时用 `extractable=true`。
 */
export async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
  extractable = false,
): Promise<CryptoKey> {
  validatePassword(password);
  return deriveKeyUnchecked(password, salt, iterations, extractable);
}

/** 派生密钥但不校验长度（解密路径：短密码也应落到统一的"密码错误"提示） */
async function deriveKeyUnchecked(
  password: string,
  salt: Uint8Array,
  iterations: number,
  extractable: boolean,
): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  );
}

/** 导出可缓存的密钥（base64 raw）——仅用于"本机无人值守定时备份"，不是密码本身 */
export async function exportKeyToBase64(key: CryptoKey): Promise<string> {
  const raw = await subtle().exportKey('raw', key);
  return bytesToBase64(new Uint8Array(raw));
}

/** 由缓存 base64 恢复密钥 */
export async function importKeyFromBase64(value: string): Promise<CryptoKey> {
  const raw = base64ToBytes(value);
  if (raw.length !== 32) throw new AppError('E_INVALID_STATE', '本机加密密钥已损坏，请重新设置密码');
  return subtle().importKey('raw', raw as unknown as BufferSource, { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/** 加密文本 → 外壳 JSON 字符串 */
export async function encryptBackupText(plain: string, opts: EncryptOptions): Promise<string> {
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS;
  const salt = opts.salt ?? generateSalt();
  let key = opts.key;
  if (!key) {
    if (!opts.password) throw new AppError('E_INVALID_INPUT', '缺少加密密码');
    key = await deriveKey(opts.password, salt, iterations);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource, tagLength: GCM_TAG_BITS },
    key,
    new TextEncoder().encode(plain),
  );
  const envelope: BackupEnvelope = {
    version: ENVELOPE_VERSION,
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(cipher)),
  };
  return JSON.stringify(envelope);
}

/** 解析外壳；非法结构返回 null（不抛错，供 UI 判定） */
export function parseEnvelope(text: string): BackupEnvelope | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec['salt'] !== 'string' || typeof rec['iv'] !== 'string' || typeof rec['data'] !== 'string') {
    return null;
  }
  if (typeof rec['version'] !== 'number' || !Number.isFinite(rec['version'])) return null;
  return {
    version: rec['version'],
    salt: rec['salt'],
    iv: rec['iv'],
    data: rec['data'],
    kdf: rec['kdf'] === 'PBKDF2-SHA256' ? 'PBKDF2-SHA256' : undefined,
    iterations: typeof rec['iterations'] === 'number' ? rec['iterations'] : undefined,
  };
}

/** 文本是否为加密外壳（含版本校验） */
export function isEncryptedBackup(text: string): boolean {
  const envelope = parseEnvelope(text);
  return envelope !== null && envelope.version === ENVELOPE_VERSION;
}

function decryptFailure(cause?: unknown): AppError {
  return new AppError('E_INVALID_INPUT', '密码错误或备份文件已损坏', { cause });
}

/** 用已派生的密钥解密（校验块比对、本机会话内解密用） */
export async function decryptBackupTextWithKey(text: string, key: CryptoKey): Promise<string> {
  const envelope = parseEnvelope(text);
  if (!envelope) throw new AppError('E_PARSE', '备份文件格式不支持');
  if (envelope.version !== ENVELOPE_VERSION) {
    throw new AppError('E_VERSION_UNSUPPORTED', '加密备份版本不支持，请升级 App');
  }
  try {
    const plain = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(envelope.iv) as unknown as BufferSource,
        tagLength: GCM_TAG_BITS,
      },
      key,
      base64ToBytes(envelope.data) as unknown as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch (e) {
    throw decryptFailure(e);
  }
}

/**
 * 用密码解密。
 *
 * 密码错误 / 文件被篡改在 GCM 下同为一个认证失败，故统一提示
 * 「密码错误或备份文件已损坏」，避免把密文细节暴露给用户。
 */
export async function decryptBackupText(text: string, password: string): Promise<string> {
  const envelope = parseEnvelope(text);
  if (!envelope) throw new AppError('E_PARSE', '备份文件格式不支持');
  if (envelope.version !== ENVELOPE_VERSION) {
    throw new AppError('E_VERSION_UNSUPPORTED', '加密备份版本不支持，请升级 App');
  }
  if (!password) throw new AppError('E_INVALID_INPUT', '请输入备份密码');
  let key: CryptoKey;
  try {
    key = await deriveKeyUnchecked(
      password,
      base64ToBytes(envelope.salt),
      envelope.iterations ?? PBKDF2_ITERATIONS,
      false,
    );
  } catch (e) {
    throw decryptFailure(e);
  }
  return decryptBackupTextWithKey(text, key);
}

/** 生成密码校验块（对固定明文做一次加密） */
export async function createVerifier(key: CryptoKey): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const cipher = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource, tagLength: GCM_TAG_BITS },
    key,
    new TextEncoder().encode(KEY_CHECK_PLAINTEXT),
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`;
}

/** 用密码 + 已保存的 salt/verifier 校验密码是否正确（不接触备份文件） */
export async function verifyPassword(
  password: string,
  saltB64: string,
  verifier: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<boolean> {
  if (!password || !saltB64 || !verifier) return false;
  const sep = verifier.indexOf('.');
  if (sep <= 0) return false;
  try {
    const iv = base64ToBytes(verifier.slice(0, sep));
    const data = base64ToBytes(verifier.slice(sep + 1));
    const key = await deriveKey(password, base64ToBytes(saltB64), iterations);
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource, tagLength: GCM_TAG_BITS },
      key,
      data as unknown as BufferSource,
    );
    return new TextDecoder().decode(plain) === KEY_CHECK_PLAINTEXT;
  } catch {
    // 密码不匹配 → GCM 认证失败 → false（不区分原因，避免泄漏）
    return false;
  }
}
