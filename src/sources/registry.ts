/**
 * 源适配器注册表（API-02）
 */
import { AppError } from '@/shared/errors';
import { AlistAdapter } from '@/sources/alist/AlistAdapter';
import { DemoAdapter } from '@/sources/demo/DemoAdapter';
import { DoubanAdapter } from '@/sources/douban/DoubanAdapter';
import { JellyfinAdapter } from '@/sources/jellyfin/JellyfinAdapter';
import { SiteAdapter } from '@/sources/site/SiteAdapter';
import { SpiderAdapter } from '@/sources/spider/SpiderAdapter';
import { WebDavAdapter } from '@/sources/webdav/WebDavAdapter';
import type { Source, SourceAdapter, SourceType } from '@/types';

export interface SourceRegistry {
  register(adapter: SourceAdapter): void;
  /** 未注册 → `E_UNSUPPORTED_FORMAT` */
  get(type: SourceType): SourceAdapter;
  has(type: SourceType): boolean;
  listTypes(): SourceType[];
  /** 源被禁用 → `E_SOURCE_DISABLED` */
  forSource(source: Source): SourceAdapter;
}

class Registry implements SourceRegistry {
  private readonly adapters = new Map<SourceType, SourceAdapter>();

  register(adapter: SourceAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  get(type: SourceType): SourceAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new AppError('E_UNSUPPORTED_FORMAT', '暂不支持该源类型');
    }
    return adapter;
  }

  has(type: SourceType): boolean {
    return this.adapters.has(type);
  }

  listTypes(): SourceType[] {
    return [...this.adapters.keys()];
  }

  forSource(source: Source): SourceAdapter {
    if (!source.enabled && source.type !== 'demo') {
      throw new AppError('E_SOURCE_DISABLED');
    }
    return this.get(source.type);
  }
}

export const sourceRegistry: SourceRegistry = new Registry();

/* 内置注册（模块加载即完成，保证任何入口都能拿到全部类型） */
sourceRegistry.register(new DemoAdapter());
sourceRegistry.register(new AlistAdapter());
sourceRegistry.register(new WebDavAdapter());
sourceRegistry.register(new JellyfinAdapter());
sourceRegistry.register(new SiteAdapter());
sourceRegistry.register(new SpiderAdapter());
sourceRegistry.register(new DoubanAdapter());

/** 测试辅助：重新注册内置适配器（不改变顺序） */
export function resetRegistryToDefaults(): void {
  sourceRegistry.register(new DemoAdapter());
  sourceRegistry.register(new AlistAdapter());
  sourceRegistry.register(new WebDavAdapter());
  sourceRegistry.register(new JellyfinAdapter());
  sourceRegistry.register(new SiteAdapter());
  sourceRegistry.register(new SpiderAdapter());
  sourceRegistry.register(new DoubanAdapter());
}
