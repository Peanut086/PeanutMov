/**
 * Android PiP 适配层（OPT-06）
 *
 * 能力检测 + 进入/退出画中画。Web 端使用标准 Picture-in-Picture API；
 * 不支持时 `isSupported()` 返回 false，调用方应隐藏 PiP 按钮。
 *
 * 注意：iOS Safari 不支持 Web PiP API（仅 HLS 原生），此处不做强行兼容。
 */

/** 查询当前页面内的主 video 元素（播放器只会有一个） */
function queryVideo(): HTMLVideoElement | null {
  if (typeof document !== 'object') return null;
  return document.querySelector<HTMLVideoElement>('video');
}

export const pipService = {
  /** 检测当前环境是否支持画中画（Android WebView / 桌面 Chrome） */
  async isSupported(): Promise<boolean> {
    if (typeof document !== 'object') return false;
    if (!('pictureInPictureEnabled' in document)) return false;
    if (!(document as unknown as { pictureInPictureEnabled: boolean }).pictureInPictureEnabled) return false;
    // 排除 iOS（iPhone/iPad/iPod），其他平台依赖 API 能力检测
    const ua = typeof navigator === 'object' ? navigator.userAgent : '';
    if (/iphone|ipad|ipod/i.test(ua)) return false;
    // 检查 video 元素是否支持 PiP
    const video = queryVideo();
    return video !== null && typeof video.requestPictureInPicture === 'function';
  },

  /** 当前是否已处于画中画 */
  isActive(): boolean {
    if (typeof document !== 'object') return false;
    return !!(document as unknown as { pictureInPictureElement: Element | null }).pictureInPictureElement;
  },

  /** 进入画中画（找到页面内 video 元素并请求） */
  async enter(): Promise<void> {
    const video = queryVideo();
    if (!video) return;
    const doc = document as unknown as { pictureInPictureEnabled: boolean };
    if (!doc.pictureInPictureEnabled) return;
    // 禁用前必须先启用，否则部分浏览器拒绝进入 PiP
    if (video.disablePictureInPicture) video.disablePictureInPicture = false;
    // 若已处于 PiP，不再重复请求
    if ((document as unknown as { pictureInPictureElement: Element | null }).pictureInPictureElement) return;
    await video.requestPictureInPicture();
  },

  /** 退出画中画 */
  async exit(): Promise<void> {
    const doc = document as unknown as {
      pictureInPictureElement: Element | null;
      exitPictureInPicture: () => Promise<void>;
    };
    if (!doc.pictureInPictureElement) return;
    await doc.exitPictureInPicture();
  },

  /** 注册 PiP 事件监听（进入/退出/错误），返回取消注册函数 */
  listen(handlers: {
    onEnter?: () => void;
    onLeave?: () => void;
    onError?: (err: Event) => void;
  }): () => void {
    const video = queryVideo();
    if (!video) return () => undefined;
    const onEnter = (): void => handlers.onEnter?.();
    const onLeave = (): void => handlers.onLeave?.();
    const onError = (ev: Event): void => handlers.onError?.(ev);
    video.addEventListener('enterpictureinpicture', onEnter);
    video.addEventListener('leavepictureinpicture', onLeave);
    video.addEventListener('error', onError);
    return () => {
      video.removeEventListener('enterpictureinpicture', onEnter);
      video.removeEventListener('leavepictureinpicture', onLeave);
      video.removeEventListener('error', onError);
    };
  },
};
