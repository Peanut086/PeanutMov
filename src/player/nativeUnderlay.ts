/**
 * 原生引擎（ExoPlayer）的画面叠在 WebView 之下，页面底色不让开就只剩黑屏有声。
 *
 * 整页透明会把浅色主题变成「黑底深字」，所以只在播放器所在的那条横带上挖洞：
 * 页面底色换成硬边渐变，洞的位置按播放器在页面内的偏移算——文档滚动时两者
 * 一起位移，差值不变，故只需在尺寸变化时重算，不用逐帧跟滚动。
 */
export function applyNativeUnderlay(stage: HTMLElement, fullscreen: boolean): () => void {
  const root = document.documentElement;
  root.classList.add('native-underlay');
  // 全屏时播放器本身是透明的，页面内容会「透过」它盖在画面上（z-index 管不了），
  // 只能把播放器之外的绘制整条藏掉，见 player.css 的 native-full 规则
  root.classList.toggle('native-full', fullscreen);

  const page = stage.closest<HTMLElement>('.route-view');
  if (!page) {
    return () => {
      root.classList.remove('native-underlay');
      root.classList.remove('native-full');
    };
  }

  page.classList.add('native-hole');
  const measure = (): void => {
    if (fullscreen) {
      // 全屏时画面铺满视口，页面任何不透明区域都会盖住它
      page.style.setProperty('--native-hole-top', '0px');
      page.style.setProperty('--native-hole-bottom', '100%');
      return;
    }
    const rect = stage.getBoundingClientRect();
    const top = Math.max(0, rect.top - page.getBoundingClientRect().top);
    page.style.setProperty('--native-hole-top', `${top}px`);
    page.style.setProperty('--native-hole-bottom', `${top + rect.height}px`);
  };
  measure();

  const observer = new ResizeObserver(measure);
  observer.observe(page);
  observer.observe(stage);
  window.addEventListener('resize', measure);

  return () => {
    observer.disconnect();
    window.removeEventListener('resize', measure);
    page.classList.remove('native-hole');
    page.style.removeProperty('--native-hole-top');
    page.style.removeProperty('--native-hole-bottom');
    root.classList.remove('native-underlay');
    root.classList.remove('native-full');
  };
}