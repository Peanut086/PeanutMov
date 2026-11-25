import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LUMA_CELLS } from '@/player/danmakuContrast';

vi.mock('@/native/exoPlayerPlugin', () => ({ ExoPlayer: {} }));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('videoFrameLumaSource', () => {
  it.each(['drawImage', 'getImageData'] as const)(
    '%s 遇到跨域污染后丢弃旧 Canvas，后续同源视频仍可取样',
    async (failure) => {
      const video = { videoWidth: 320, videoHeight: 180, readyState: 2 } as HTMLVideoElement;
      const stage = { querySelector: () => video } as unknown as HTMLElement;
      const contexts: CanvasRenderingContext2D[] = [];
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        if (tag !== 'canvas') return originalCreateElement(tag);
        const context = {
          setTransform: vi.fn(),
          clearRect: vi.fn(),
          drawImage: vi.fn(),
          getImageData: vi.fn(() => ({
            data: new Uint8ClampedArray(LUMA_CELLS * 4),
          })),
        } as unknown as CanvasRenderingContext2D;
        if (contexts.length === 0 && failure === 'drawImage') {
          context.drawImage = vi.fn(() => {
            throw new DOMException('tainted', 'SecurityError');
          });
        }
        if (contexts.length === 0 && failure === 'getImageData') {
          context.getImageData = vi.fn(() => {
            throw new DOMException('tainted', 'SecurityError');
          });
        }
        contexts.push(context);
        return {
          width: 0,
          height: 0,
          getContext: () => context,
        } as unknown as HTMLCanvasElement;
      }) as typeof document.createElement);

      const { videoFrameLumaSource } = await import('@/player/frameLuma');
      const source = videoFrameLumaSource(() => stage);
      let caught: unknown;
      try {
        source(320, 180, 'fill');
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        name: 'FrameLumaUnavailableError',
        reason: 'tainted',
      });

      const recovered = await source(320, 180, 'fill');
      expect(contexts).toHaveLength(2);
      expect(recovered?.cells).toHaveLength(LUMA_CELLS);
    },
  );
});
