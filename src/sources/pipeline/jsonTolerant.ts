/**
 * 容错 JSON 解析（从 `subscriptionParser` 下沉，单一实现）
 *
 * 现实里大量 TVBox 订阅是手工编辑的：作者用 `//` 注释掉不要的源，
 * 或用 `//////` 画分隔线；长字符串被编辑器硬折行成两行（`"优` + `酷"`）。
 * TVBox 客户端用宽容解析器能吞掉这些，标准 `JSON.parse` 不能。
 *
 * 三层递进（严格 → 剥注释 → 拼折行），只在严格解析失败后兜底，
 * 不改变合法 JSON 的解析路径。
 */
export type RelaxedLevel = 'none' | 'comments' | 'wrapped' | 'both';

export interface TolerantParseOk {
  value: unknown;
  relaxed: RelaxedLevel;
}

/** 整行 `//` 注释剥离（行首空白后紧跟 `//`），不做行尾剥离：URL 里 `//` 极常见 */
export function stripLineComments(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

/** 一行里"未转义的双引号"数量 */
function quoteCount(line: string): number {
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] === '"') count++;
  }
  return count;
}

/**
 * 拼接被编辑器硬折行的字符串。
 *
 * 判据：**本行未转义引号为奇数** → 说明有个字符串没闭合，把下一行原样接上。
 * 该判据对合法 JSON 安全：转义引号（`\"`）、URL 里的 `//`、emoji
 * 都不会造成引号计数为奇（已用 package.json / tsconfig / 含转义引号样本验证）。
 */
export function joinWrappedStrings(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (quoteCount(line) % 2 === 1 && i + 1 < lines.length) {
      out.push(line + lines[i + 1]);
      i++;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** 宽松解析：严格失败时依次尝试剥注释、拼折行；全部失败返回 null */
export function tolerantParse(text: string): TolerantParseOk | null {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length === 0) return null;

  try {
    return { value: JSON.parse(trimmed) as unknown, relaxed: 'none' };
  } catch {
    // 走容错链
  }

  const withoutComments = stripLineComments(trimmed);
  const commentStripped = withoutComments !== trimmed;
  const joined = joinWrappedStrings(withoutComments);
  const wrappedJoined = joined !== withoutComments;

  if (commentStripped || wrappedJoined) {
    try {
      return {
        value: JSON.parse(joined) as unknown,
        relaxed: commentStripped && wrappedJoined ? 'both' : commentStripped ? 'comments' : 'wrapped',
      };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 给解析失败一个可操作的诊断，而不是笼统的"不是合法 JSON"。
 *
 * 关键：诊断必须基于**剥离注释后**的重新解析错误，而不是原始错误。
 * 否则含注释的文件会一直把"注释"当唯一原因报出来，掩盖真正的问题
 * （如字符串被折行截断）——用户按提示删了注释还是导不进去。
 */
export function diagnoseJsonFailure(text: string, error: unknown): string {
  const original = error instanceof Error ? error.message : '';

  let afterStrip = original;
  const withoutComments = stripLineComments(text);
  if (withoutComments !== text) {
    try {
      JSON.parse(withoutComments);
      return '该订阅含 // 注释（非标准 JSON），已尝试忽略注释但仍需修正格式';
    } catch (e) {
      afterStrip = e instanceof Error ? e.message : original;
    }
  }

  if (/Bad control character|Unterminated string/i.test(afterStrip)) {
    const line = /line (\d+)/i.exec(afterStrip)?.[1];
    return line
      ? `第 ${line} 行附近有未转义的换行或缺失引号，可能是手工编辑时被折行截断`
      : '字符串里有未转义的换行或缺失引号，可能是手工编辑时被折行截断';
  }
  if (/Unexpected token '\/'|Unexpected token \//i.test(afterStrip)) {
    return '该订阅含 // 注释或多余的 / 字符，不是标准 JSON';
  }
  if (/Unexpected end of JSON input|Expected ',' or '\}'/i.test(afterStrip)) {
    return 'JSON 内容不完整（可能被截断），请确认地址可完整下载';
  }
  if (/Expected (property name|double-quoted property name)/i.test(afterStrip)) {
    return 'JSON 结构有误：缺少属性名或多余逗号，可能是手工编辑时改坏的';
  }
  if (/Unexpected token ']'|Unexpected token '}'/i.test(afterStrip)) {
    return 'JSON 结构有误：疑似有多余逗号，可能是手工编辑时改坏的';
  }
  return '内容不是合法 JSON';
}
