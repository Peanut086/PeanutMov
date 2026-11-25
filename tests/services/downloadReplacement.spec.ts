import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  records: new Map<string, import('@/types').DownloadTask>(),
  blobs: new Map<string, { size: number }>(),
  get: vi.fn(),
  listByEpisode: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  stat: vi.fn(),
  readTextFile: vi.fn(),
  renameFile: vi.fn(),
  deleteFile: vi.fn(),
  writeBase64: vi.fn(),
  scanTsFile: vi.fn(),
  verifyRemuxedMedia: vi.fn(),
  blobGet: vi.fn(),
  blobDelete: vi.fn(),
  emit: vi.fn(),
  failSaveId: null as string | null,
  failRemoveId: null as string | null,
}));

vi.mock('@/db/repositories/downloadRepo', () => ({
  downloadRepo: { get: h.get, listByEpisode: h.listByEpisode, save: h.save, remove: h.remove },
}));
vi.mock('@/db/repositories/blobRepo', () => ({
  blobRepo: { get: h.blobGet, delete: h.blobDelete },
}));
vi.mock('@/native/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/native/fs')>();
  return {
    ...actual,
    stat: h.stat,
    readTextFile: h.readTextFile,
    renameFile: h.renameFile,
    deleteFile: h.deleteFile,
    writeBase64: h.writeBase64,
  };
});
vi.mock('@/native/mediaToolPlugin', () => ({
  scanTsFile: h.scanTsFile,
  verifyRemuxedMedia: h.verifyRemuxedMedia,
}));
vi.mock('@/services/events', () => ({ appEvents: { emit: h.emit } }));
vi.mock('@/shared/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { buildLocalHlsManifest } from '@/services/localHlsIndex';
import { createSafeReplacement, promoteReplacement } from '@/services/downloadReplacement';
import type { DownloadHlsIndex, DownloadTask } from '@/types';

const PATH = '/downloads/m1/e1.ts';
const OLD_MANIFEST = '/downloads/m1/e1.m3u8';
const CANDIDATE_PATH = '/downloads/m1/e1.replacement.ts';
const CANDIDATE_MANIFEST = '/downloads/m1/e1.replacement.m3u8';
const CANDIDATE_DATA = 'n'.repeat(188);

function index(fingerprint = 'candidate-index'): DownloadHlsIndex {
  return {
    version: 1,
    playlistFingerprint: fingerprint,
    targetDuration: 1,
    mediaSequence: 0,
    segments: [
      { index: 0, offset: 0, length: 188, duration: 1, discontinuity: false },
    ],
  };
}

function oldTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = Date.now();
  return {
    id: 'old',
    sourceId: 'demo',
    mediaId: 'm1',
    episodeId: 'e1',
    episodeNumber: 1,
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://cdn.example.com/media.m3u8',
    headers: {},
    format: 'hls',
    quality: null,
    status: 'completed',
    priority: 1,
    totalBytes: 188,
    downloadedBytes: 188,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: false,
    sink: 'filesystem',
    filePath: PATH,
    blobKey: null,
    container: 'ts',
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    ...overrides,
  };
}

async function completedCandidate(): Promise<DownloadTask> {
  const candidate = await createSafeReplacement('old');
  const localIndex = index();
  const completed: DownloadTask = {
    ...candidate,
    status: 'completed',
    filePath: CANDIDATE_PATH,
    artifactPath: CANDIDATE_PATH,
    downloadedBytes: 188,
    totalBytes: 188,
    container: 'ts',
    hlsIndex: localIndex,
    hlsIndexPath: CANDIDATE_MANIFEST,
    hlsTotalSegments: 1,
    hlsDiscontinuities: 0,
    hlsPlaylistFingerprint: localIndex.playlistFingerprint,
    completedAt: Date.now(),
  };
  h.records.set(completed.id, completed);
  h.files.set(CANDIDATE_PATH, CANDIDATE_DATA);
  h.files.set(CANDIDATE_MANIFEST, buildLocalHlsManifest(localIndex, CANDIDATE_PATH));
  return completed;
}

beforeEach(() => {
  h.files.clear();
  h.records.clear();
  h.blobs.clear();
  h.failSaveId = null;
  h.failRemoveId = null;
  for (const fn of [
    h.get, h.listByEpisode, h.save, h.remove, h.stat, h.readTextFile,
    h.renameFile, h.deleteFile, h.writeBase64, h.scanTsFile,
    h.verifyRemuxedMedia, h.blobGet, h.blobDelete, h.emit,
  ]) fn.mockReset();

  const old = oldTask();
  h.records.set(old.id, old);
  h.files.set(PATH, 'old-ts');
  h.files.set(OLD_MANIFEST, 'old-manifest');
  h.get.mockImplementation(async (id: string) => h.records.get(id) ?? null);
  h.listByEpisode.mockImplementation(async () => [...h.records.values()]);
  h.save.mockImplementation(async (task: DownloadTask) => {
    if (h.failSaveId === task.id) throw new Error('IndexedDB quota exceeded');
    h.records.set(task.id, task);
  });
  h.remove.mockImplementation(async (id: string) => {
    if (h.failRemoveId === id) throw new Error('delete failed');
    h.records.delete(id);
  });
  h.stat.mockImplementation(async (path: string) => {
    const content = h.files.get(path);
    return content === undefined
      ? { exists: false, size: 0 }
      : { exists: true, size: new TextEncoder().encode(content).byteLength };
  });
  h.readTextFile.mockImplementation(async (path: string) => {
    const content = h.files.get(path);
    if (content === undefined) throw new Error('ENOENT');
    return content;
  });
  h.writeBase64.mockImplementation(async (path: string, base64: string) => {
    h.files.set(path, Buffer.from(base64, 'base64').toString('utf8'));
  });
  h.renameFile.mockImplementation(async (from: string, to: string) => {
    const content = h.files.get(from);
    if (content === undefined) throw new Error(`ENOENT:${from}`);
    if (h.files.has(to)) throw new Error(`EEXIST:${to}`);
    h.files.set(to, content);
    h.files.delete(from);
  });
  h.deleteFile.mockImplementation(async (path: string) => { h.files.delete(path); });
  h.scanTsFile.mockResolvedValue({ ok: true });
  h.verifyRemuxedMedia.mockResolvedValue({ ok: true, probeVerdict: 'pass' });
  h.blobGet.mockImplementation(async (key: string) => h.blobs.get(key) ?? null);
  h.blobDelete.mockImplementation(async (key: string) => { h.blobs.delete(key); });
});

describe('安全重下候选', () => {
  it('创建独立任务和路径，旧 completed 记录与产物完全不动', async () => {
    const oldBefore = { ...h.records.get('old')! };

    const candidate = await createSafeReplacement('old');
    const second = await createSafeReplacement('old');

    expect(second.id).toBe(candidate.id);
    expect(candidate).toMatchObject({
      status: 'queued',
      replacesTaskId: 'old',
      artifactPath: CANDIDATE_PATH,
      filePath: null,
      blobKey: null,
      hlsIndex: null,
      hlsIndexPath: null,
      linkResolvedAt: 0,
    });
    expect(h.records.get('old')).toEqual(oldBefore);
    expect(h.files.get(PATH)).toBe('old-ts');
    expect(h.files.get(OLD_MANIFEST)).toBe('old-manifest');
    expect(h.files.has(CANDIDATE_PATH)).toBe(false);
  });

  it('候选复检不通过时不触碰旧媒体和旧清单', async () => {
    const candidate = await completedCandidate();
    h.scanTsFile.mockResolvedValue({ ok: false, verdict: 'corrupt' });

    await expect(promoteReplacement(candidate.id)).rejects.toThrow('结构复检未通过');

    expect(h.renameFile).not.toHaveBeenCalled();
    expect(h.deleteFile).not.toHaveBeenCalled();
    expect(h.files.get(PATH)).toBe('old-ts');
    expect(h.files.get(OLD_MANIFEST)).toBe('old-manifest');
    expect(h.records.get('old')?.filePath).toBe(PATH);
    expect(h.records.has(candidate.id)).toBe(true);
  });

  it('复检通过后替换旧文件，旧任务 ID 和剧集信息保留', async () => {
    const candidate = await completedCandidate();
    const localIndex = candidate.hlsIndex!;

    await expect(promoteReplacement(candidate.id)).resolves.toBeUndefined();

    expect(h.files.get(PATH)).toBe(CANDIDATE_DATA);
    expect(h.files.get(OLD_MANIFEST)).toBe(buildLocalHlsManifest(localIndex, PATH));
    expect(h.files.has(`${PATH}.replacement-old`)).toBe(false);
    expect(h.files.has(`${OLD_MANIFEST}.replacement-old`)).toBe(false);
    expect(h.files.has(CANDIDATE_PATH)).toBe(false);
    expect(h.files.has(CANDIDATE_MANIFEST)).toBe(false);
    expect(h.records.has(candidate.id)).toBe(false);
    expect(h.records.get('old')).toMatchObject({
      id: 'old',
      title: '影片',
      episodeId: 'e1',
      status: 'completed',
      filePath: PATH,
      hlsIndex: localIndex,
      hlsIndexPath: OLD_MANIFEST,
    });
  });

  it('提交前落库失败时恢复旧媒体、旧清单和独立候选', async () => {
    const candidate = await completedCandidate();
    h.failSaveId = 'old';

    await expect(promoteReplacement(candidate.id)).rejects.toThrow('quota');

    expect(h.files.get(PATH)).toBe('old-ts');
    expect(h.files.get(OLD_MANIFEST)).toBe('old-manifest');
    expect(h.files.get(CANDIDATE_PATH)).toBe(CANDIDATE_DATA);
    expect(h.files.get(CANDIDATE_MANIFEST)).toBe(buildLocalHlsManifest(candidate.hlsIndex!, CANDIDATE_PATH));
    expect(h.files.has(`${PATH}.replacement-old`)).toBe(false);
    expect(h.files.has(`${OLD_MANIFEST}.replacement-old`)).toBe(false);
    expect(h.records.get('old')?.filePath).toBe(PATH);
    expect(h.records.has(candidate.id)).toBe(true);
  });

  it('提交后候选记录清理失败不触发重试，并把残留记录中和为失败', async () => {
    const candidate = await completedCandidate();
    h.failRemoveId = candidate.id;

    await expect(promoteReplacement(candidate.id)).resolves.toBeUndefined();

    expect(h.files.get(PATH)).toBe(CANDIDATE_DATA);
    expect(h.records.get('old')?.filePath).toBe(PATH);
    expect(h.records.get(candidate.id)).toMatchObject({
      status: 'failed',
      filePath: null,
      artifactPath: null,
      errorCode: 'E_DB',
    });
  });

  it('Blob 候选提交前失败保留旧 Blob，提交后才删除旧 Blob', async () => {
    const old = oldTask({ sink: 'idb-blob', filePath: null, blobKey: 'old-blob' });
    h.records.set('old', old);
    h.files.delete(PATH);
    h.files.delete(OLD_MANIFEST);
    h.blobs.set('old-blob', { size: 188 });
    const candidate = await createSafeReplacement('old');
    const completed: DownloadTask = {
      ...candidate,
      status: 'completed',
      blobKey: 'candidate-blob',
      downloadedBytes: 188,
      totalBytes: 188,
    };
    h.records.set(completed.id, completed);
    h.blobs.set('candidate-blob', { size: 188 });
    h.failSaveId = 'old';

    await expect(promoteReplacement(completed.id)).rejects.toThrow('quota');
    expect(h.records.get('old')?.blobKey).toBe('old-blob');
    expect(h.blobs.has('old-blob')).toBe(true);
    expect(h.blobDelete).not.toHaveBeenCalled();

    h.failSaveId = null;
    h.failRemoveId = completed.id;
    await expect(promoteReplacement(completed.id)).resolves.toBeUndefined();
    expect(h.records.get('old')?.blobKey).toBe('candidate-blob');
    expect(h.blobs.has('old-blob')).toBe(false);
    expect(h.blobs.has('candidate-blob')).toBe(true);
    expect(h.records.get(completed.id)?.status).toBe('failed');
  });
});
