/**
 * 解析器注册表（复刻 `src/sources/registry.ts` 的形态）
 *
 * 契约（写进文件头，评审时逐条核对）：
 * - 解析器**不发网络请求**（网络归调度器，否则预算/熔断/并发全部失效）；
 * - 只允许抛 `AppError`，禁止抛裸 `Error`/字符串（否则诊断丢 code）；
 * - 不得写 DOM / 改全局状态 / 读 IndexedDB；
 * - 同一输入必须确定性输出（便于回放 fixture）。
 */
import { AppError } from '@/shared/errors';
import {
  htmlMediaParser,
  jsonTvboxParser,
  rejectFixedParser,
  subRawParser,
  textCharsetParser,
  xmlVodParser,
} from './parsers';
import type { CrawlIntent, CrawlParser, ParserId, ParserRegistry } from './types';

class Registry implements ParserRegistry {
  private readonly parsers = new Map<ParserId, CrawlParser>();

  register(parser: CrawlParser): void {
    this.parsers.set(parser.id, parser);
  }

  require(id: ParserId): CrawlParser {
    const parser = this.parsers.get(id);
    if (!parser) {
      throw new AppError('E_UNSUPPORTED_FORMAT', `解析器未注册：${id}`);
    }
    return parser;
  }

  has(id: ParserId): boolean {
    return this.parsers.has(id);
  }

  list(): CrawlParser[] {
    return [...this.parsers.values()];
  }

  /** 该解析器是否支持此 intent（规则加载期校验越界用） */
  supports(id: ParserId, intent: CrawlIntent): boolean {
    return this.parsers.get(id)?.intents.includes(intent) ?? false;
  }
}

export const parserRegistry: ParserRegistry = new Registry();

const BUILTIN_PARSERS: readonly CrawlParser[] = [
  jsonTvboxParser,
  subRawParser,
  textCharsetParser,
  htmlMediaParser,
  xmlVodParser,
  rejectFixedParser,
];

/* 内置注册（模块加载即完成，保证任何入口都能拿到全部解析器） */
for (const parser of BUILTIN_PARSERS) parserRegistry.register(parser);

/** 测试辅助：重新注册内置解析器（不改变顺序） */
export function resetParsersToDefaults(): void {
  for (const parser of BUILTIN_PARSERS) parserRegistry.register(parser);
}
