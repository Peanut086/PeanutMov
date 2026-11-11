/**
 * 作用域动态染色（详情页 / 播放页）
 *
 * 把海报主色派生出的品牌变量挂到页面根节点上，只影响该子树——
 * 首页与 TabBar 始终保留默认品牌色，避免 App 的身份色被每部影片冲淡。
 * 主题切换时按新的页面底色重新派生（缓存的是海报主色，不是角色色）。
 */
import { onMounted, onUnmounted, watch, type Ref } from 'vue';

import { useTheme } from '@/composables/useTheme';
import { applyPalette, clearPalette, paletteForPoster, type PaletteSeed } from '@/services/paletteService';

export function useScopedPalette(
  rootRef: Ref<HTMLElement | null>,
  posterUrl: Ref<string | null | undefined>,
): void {
  const { resolved } = useTheme();
  let seed: PaletteSeed | null = null;
  /** 换片 / 卸载后到达的旧结果不能覆盖当前状态 */
  let token = 0;

  function apply(): void {
    const el = rootRef.value;
    if (!el) return;
    if (!applyPalette(el, seed)) clearPalette(el);
  }

  async function load(url: string | null | undefined): Promise<void> {
    const current = ++token;
    seed = null;
    apply();
    const next = await paletteForPoster(url);
    if (current !== token) return;
    seed = next;
    apply();
  }

  watch(posterUrl, (url) => void load(url), { immediate: true });
  watch(resolved, apply);

  onMounted(apply);
  onUnmounted(() => {
    token += 1;
  });
}
