/**
 * WebDAV `PROPFIND` 响应解析（纯函数，无 IO）
 *
 * 输入为 XML 文本，输出规范化后的资源列表。要求：
 * - 同时支持 `D:response` 与无命名空间前缀的 `response`；
 * - 正确处理中文、`&amp;` 等实体与 CDATA；
 * - 空响应、非 WebDAV XML 返回空数组（调用方按"目录为空"处理）；
 * - 目录以 `resourcetype/collection` 判定，并解码 `%xx`。
 */
export interface WebDavResource {
  href: string;
  /** 已 decodeURIComponent 的路径 */
  path: string;
  name: string;
  isDir: boolean;
  /** 字节；目录为 0 */
  size: number;
  lastModified: string | null;
  contentType: string | null;
  etag: string | null;
}

function parseXml(text: string): Document | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const parser = new DOMParser();
  const doc = parser.parseFromString(trimmed, 'application/xml');
  // DOMParser 解析失败时返回包含 parsererror 的文档
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  return doc;
}

/** 取元素的直接子元素（忽略命名空间），按本地名匹配 */
function childrenByLocalName(parent: Element, localName: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < parent.children.length; i += 1) {
    const child = parent.children.item(i);
    if (child && (child.localName === localName || child.nodeName === localName)) out.push(child);
  }
  return out;
}

function firstByLocalName(parent: Element, localName: string): Element | null {
  return childrenByLocalName(parent, localName)[0] ?? null;
}

/** 深度查找（部分服务端把 propstat/prop 再嵌一层） */
function findFirst(parent: Element, localName: string): Element | null {
  const direct = firstByLocalName(parent, localName);
  if (direct) return direct;
  for (let i = 0; i < parent.children.length; i += 1) {
    const child = parent.children.item(i);
    if (!child) continue;
    const found = findFirst(child, localName);
    if (found) return found;
  }
  return null;
}

function textOf(element: Element | null): string {
  if (!element) return '';
  return (element.textContent ?? '').trim();
}

/** 解码 href：去掉查询串与 hash，decodeURIComponent 安全兜底 */
function decodeHref(href: string): string {
  const withoutQuery = href.split('?')[0] ?? href;
  const withoutHash = withoutQuery.split('#')[0] ?? withoutQuery;
  try {
    return decodeURIComponent(withoutHash);
  } catch {
    return withoutHash;
  }
}

function baseNameOf(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function toNumber(value: string): number {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/** 解析 PROPFIND 响应 */
export function parseWebDavXml(xml: string): WebDavResource[] {
  const doc = parseXml(xml);
  if (!doc) return [];

  const responses: Element[] = [];
  const collect = (parent: Element | Document): void => {
    for (let i = 0; i < parent.children.length; i += 1) {
      const child = parent.children.item(i);
      if (!child) continue;
      if (child.localName === 'response' || child.nodeName === 'response' || child.nodeName === 'D:response') {
        responses.push(child);
      } else if (child.localName === 'multistatus' || child.nodeName === 'D:multistatus') {
        collect(child);
      }
    }
  };
  collect(doc);

  const out: WebDavResource[] = [];
  for (const response of responses) {
    const href = textOf(findFirst(response, 'href'));
    if (href.length === 0) continue;

    const path = decodeHref(href);
    const propstat = findFirst(response, 'propstat');
    const prop = (propstat ? findFirst(propstat, 'prop') : null) ?? findFirst(response, 'prop');

    // 只取 HTTP 200 的 propstat（部分服务端会同时返回 404 的 propstat）
    let effectiveProp = prop;
    const propstats: Element[] = [];
    for (let i = 0; i < response.children.length; i += 1) {
      const child = response.children.item(i);
      if (child && child.localName === 'propstat') propstats.push(child);
    }
    const okPropstat = propstats.find((ps) => textOf(findFirst(ps, 'status')).includes('200'));
    if (okPropstat) effectiveProp = findFirst(okPropstat, 'prop');

    const resourceType = effectiveProp ? findFirst(effectiveProp, 'resourcetype') : null;
    const isDir =
      Boolean(resourceType && findFirst(resourceType, 'collection')) ||
      // 末尾带 `/` 但无 resourcetype 时也按目录处理（部分服务端裁剪字段）
      path.endsWith('/');

    const displayName = textOf(effectiveProp ? findFirst(effectiveProp, 'displayname') : null);
    const name = displayName.length > 0 ? displayName : baseNameOf(path);

    out.push({
      href,
      path,
      name,
      isDir,
      size: isDir ? 0 : toNumber(textOf(effectiveProp ? findFirst(effectiveProp, 'getcontentlength') : null)),
      lastModified: textOf(effectiveProp ? findFirst(effectiveProp, 'getlastmodified') : null) || null,
      contentType: textOf(effectiveProp ? findFirst(effectiveProp, 'getcontenttype') : null) || null,
      etag: textOf(effectiveProp ? findFirst(effectiveProp, 'getetag') : null) || null,
    });
  }
  return out;
}

/** 判断一个资源是否是"请求的目录本身"（PROPFIND Depth:1 会返回自身） */
export function isSelfEntry(resource: WebDavResource, requestPath: string): boolean {
  const norm = (p: string): string => `/${p}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return norm(resource.path) === norm(requestPath);
}
