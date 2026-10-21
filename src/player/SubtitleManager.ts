/**
 * 字幕管理器（技术方案 9.2）
 *
 * - 轨道来源：`PlaybackSource.subtitles`（远程）+ 用户本地文件（`addLocal`）
 * - SRT 自动转 WebVTT 后解析为 cue 数组，**不依赖浏览器原生字幕渲染**
 * - `textAt(currentTime)` 用二分查找命中 cue；字偏移 `offsetSec` 只影响查找基准
 * - 失败不阻断播放：抛 `AppError('E_PARSE')` 由上层 Toast 提示（AC-46）
 * - 加载失败的轨道 id 记入 `failed` 集合，供字幕面板标记「不可用」（AC-46）；
 *   切集/切线路（`setTracks` 中 id 对应 url 变化）或重试成功即清除。
 */
import type { SubtitleTrack } from '@/types';
import { AppError, httpStatusToErrorCode } from '@/shared/errors';

import { decodeSubtitle, parseVtt, srtToVtt, type ParsedCue } from '@/player/SrtConverter';

export interface SubtitleManagerOptions {
  /** 拉取远程字幕内容（默认用 fetch；可注入便于测试） */
  fetchText?: (track: SubtitleTrack) => Promise<{ text: string; format: 'srt' | 'vtt' }>;
}

interface LoadedTrack {
  track: SubtitleTrack;
  cues: ParsedCue[];
}

export class SubtitleManager {
  private loaded = new Map<string, LoadedTrack>();
  private tracks: SubtitleTrack[] = [];
  private activeId: string | null = null;
  private offsetSec = 0;
  private lastText = '';
  /** 加载失败的轨道 id（AC-46）：面板据此标记「不可用」 */
  private failed = new Set<string>();

  constructor(private readonly options: SubtitleManagerOptions = {}) {}

  setTracks(tracks: SubtitleTrack[]): void {
    const previous = new Map(this.tracks.map((t) => [t.id, t.url]));
    this.tracks = [...tracks];
    // 已加载但不在新列表中的轨道要清理，避免切集后残留
    for (const id of [...this.loaded.keys()]) {
      if (!this.tracks.some((t) => t.id === id)) this.loaded.delete(id);
    }
    // 失败标记随轨道列表收敛：已消失的、或同一 id 换了地址（重载）的都清除
    for (const id of [...this.failed]) {
      const next = this.tracks.find((t) => t.id === id);
      const before = previous.get(id);
      if (!next || (before !== undefined && before !== next.url)) {
        this.failed.delete(id);
      }
    }
    if (this.activeId && !this.tracks.some((t) => t.id === this.activeId)) {
      this.activeId = null;
      this.lastText = '';
    }
  }

  getTracks(): SubtitleTrack[] {
    return [...this.tracks];
  }

  /** 加载失败的轨道 id 集合（AC-46，供字幕面板标记「不可用」） */
  get failedTrackIds(): ReadonlySet<string> {
    return new Set(this.failed);
  }

  /** 加载失败的轨道 id 列表（数组视图，便于直接作为 props 传入） */
  getFailedIds(): string[] {
    return [...this.failed];
  }

  isFailed(id: string): boolean {
    return this.failed.has(id);
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  setOffset(offsetSec: number): void {
    this.offsetSec = Number.isFinite(offsetSec) ? offsetSec : 0;
    this.lastText = '';
  }

  getOffset(): number {
    return this.offsetSec;
  }

  /**
   * 切换字幕轨道；`null` 表示关闭。
   * 首次使用某轨道时才拉取并解析，避免起播时串行等待。
   */
  async setActive(id: string | null): Promise<void> {
    if (id === null) {
      this.activeId = null;
      this.lastText = '';
      return;
    }
    const track = this.tracks.find((t) => t.id === id);
    if (!track) throw new AppError('E_NOT_FOUND', '字幕轨道不存在');
    if (!this.loaded.has(id)) {
      let loaded: LoadedTrack;
      try {
        loaded = await this.loadTrack(track);
      } catch (e) {
        // 记录失败轨道供面板标记「不可用」，再把错误交给上层 Toast（播放不中断）
        this.failed.add(id);
        throw e;
      }
      this.failed.delete(id);
      this.loaded.set(id, loaded);
    }
    this.activeId = id;
    this.lastText = '';
  }

  /**
   * 重试加载一条失败轨道（AC-46）：成功后从失败集合移除并可立即激活。
   * 非失败轨道调用时等价于 `setActive`（已加载则直接激活）。
   */
  async retry(id: string): Promise<void> {
    this.failed.delete(id);
    this.loaded.delete(id);
    await this.setActive(id);
  }

  /** 新增本地字幕文件（拖入/文件选择）；自动设为激活轨道 */
  async addLocal(file: File, label?: string): Promise<SubtitleTrack> {
    const raw = await readFileText(file);
    const isVtt = /\.vtt$/i.test(file.name);
    const text = isVtt ? raw : srtToVtt(raw);
    const cues = parseVtt(text);
    if (cues.length === 0) throw new AppError('E_PARSE', '字幕内容无法解析');

    const id = `local:${Date.now()}`;
    const track: SubtitleTrack = {
      id,
      label: label ?? file.name.replace(/\.(srt|vtt)$/i, ''),
      lang: guessLang(file.name),
      url: `blob:local/${id}`,
      format: isVtt ? 'vtt' : 'srt',
      source: 'local',
    };
    this.tracks = [...this.tracks, track];
    this.loaded.set(id, { track, cues });
    this.activeId = id;
    this.lastText = '';
    return track;
  }

  /** 返回当前时刻应显示的字幕文本（无则空串） */
  textAt(currentTimeSec: number): string {
    if (!this.activeId) return '';
    const entry = this.loaded.get(this.activeId);
    if (!entry || entry.cues.length === 0) return '';
    const t = currentTimeSec + this.offsetSec;
    const idx = findCueIndex(entry.cues, t);
    const text = idx >= 0 ? (entry.cues[idx]?.text ?? '') : '';
    if (text !== this.lastText) this.lastText = text;
    return text;
  }

  /** 当前激活轨道的 cue 列表（测试/调试用） */
  getCues(id: string = this.activeId ?? ''): ParsedCue[] {
    return [...(this.loaded.get(id)?.cues ?? [])];
  }

  clear(): void {
    this.loaded.clear();
    this.tracks = [];
    this.activeId = null;
    this.lastText = '';
    this.offsetSec = 0;
    this.failed.clear();
  }

  private async loadTrack(track: SubtitleTrack): Promise<LoadedTrack> {
    let content: string;
    let format: 'srt' | 'vtt';
    try {
      if (this.options.fetchText) {
        const result = await this.options.fetchText(track);
        content = result.text;
        format = result.format;
      } else {
        const res = await fetch(track.url);
        if (!res.ok) {
          throw new AppError(httpStatusToErrorCode(res.status), `字幕加载失败(${res.status})`, {
            httpStatus: res.status,
          });
        }
        const buffer = await res.arrayBuffer();
        content = decodeSubtitle(buffer);
        format = track.format;
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError('E_NETWORK', '字幕加载失败，可稍后重试', { detail: String(e) });
    }

    const vtt = format === 'srt' ? srtToVtt(content) : content;
    const cues = parseVtt(vtt);
    if (cues.length === 0) throw new AppError('E_PARSE', '字幕内容无法解析');
    return { track, cues };
  }
}

/**
 * 二分查找：返回 `time` 落在哪个 cue（`startSec <= t < endSec`），未命中返回 -1。
 * cues 需按 startSec 升序（`parseVtt` 已排序）。
 */
export function findCueIndex(cues: ParsedCue[], time: number): number {
  if (cues.length === 0) return -1;
  let lo = 0;
  let hi = cues.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = cues[mid];
    if (!cue) break;
    if (cue.startSec <= time) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate < 0) return -1;
  const hit = cues[candidate];
  if (!hit) return -1;
  return time < hit.endSec ? candidate : -1;
}

function guessLang(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.includes('zh') || lower.includes('chs') || lower.includes('cht') || lower.includes('中')) return 'zh';
  if (lower.includes('en')) return 'en';
  if (lower.includes('ja') || lower.includes('jp')) return 'ja';
  return 'und';
}

async function readFileText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  return decodeSubtitle(buffer);
}
