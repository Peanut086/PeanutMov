import { createPinia } from 'pinia';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { createMemoryHistory, createRouter, useRoute, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import App from '@/App.vue';

const mountCount = ref(0);
const fullscreen = ref(false);

const PlayerProbe = defineComponent({
  setup() {
    const route = useRoute();
    onMounted(() => {
      mountCount.value += 1;
      if (mountCount.value === 1) fullscreen.value = true;
    });
    onBeforeUnmount(() => {
      fullscreen.value = false;
    });
    return {
      episodeId: computed(() => route.params.episodeId),
      fullscreen,
    };
  },
  template: '<div class="player-probe" data-route="player" :data-fullscreen="fullscreen">{{ episodeId }}</div>',
});

const Blank = defineComponent({ template: '<div />' });

let router: Router;
let wrapper: VueWrapper | null = null;

async function settle(): Promise<void> {
  await nextTick();
  await flushPromises();
  await nextTick();
}

beforeEach(async () => {
  mountCount.value = 0;
  fullscreen.value = false;
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/player/:mediaId/:episodeId?',
        name: 'player',
        component: PlayerProbe,
        meta: { immersive: true, depth: 2 },
      },
      { path: '/detail/:mediaId', name: 'detail', component: Blank, meta: { depth: 1 } },
    ],
  });
  await router.push('/player/media-a/ep1');
  await router.isReady();
  wrapper = mount(App, {
    global: {
      plugins: [createPinia(), router],
      stubs: {
        AppTabBar: true,
        ConfirmDialog: true,
        EpisodeLeader: true,
        SafeModeBanner: true,
        ToastHost: true,
      },
    },
    attachTo: document.body,
  });
  await settle();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('播放页路由实例', () => {
  it('全屏切下一集不销毁播放页，也不退出全屏', async () => {
    expect(fullscreen.value).toBe(true);

    await router.replace('/player/media-a/ep2');
    await settle();

    expect(wrapper!.find('.player-probe').text()).toBe('ep2');
    expect(mountCount.value).toBe(1);
    expect(fullscreen.value).toBe(true);
  });

  it('切换到另一部媒体仍重建播放页', async () => {
    await router.replace('/player/media-b/ep1');
    await settle();

    expect(wrapper!.find('.player-probe').text()).toBe('ep1');
    expect(mountCount.value).toBe(2);
  });

  it('播放页线路参数变化仍重建播放页', async () => {
    await router.replace({
      name: 'player',
      params: { mediaId: 'media-a', episodeId: 'ep1' },
      query: { lineId: 'line-b' },
    });
    await settle();

    expect(mountCount.value).toBe(2);
  });
});
