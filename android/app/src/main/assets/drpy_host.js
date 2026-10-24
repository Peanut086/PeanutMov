/**
 * drpy 宿主环境（CHG-16）—— 在 QuickJS 内执行的预置脚本
 *
 * 职责：
 * 1. 基于原生同步绑定（__req/__domSelect/__log/__localGet/__localSet/__b64e/__b64d/__md5）
 *    实现 drpy 规则依赖的全局 API：req/pdfa/pdfh/pd/local/log 等；
 * 2. 编排规则对象 `rule`（drpy2 ES6 函数式为主，字符串式尽力兼容），
 *    对外只暴露 `__drpyCall(method, argJson)` 一个同步入口；
 * 3. 异步规则函数（async/await）通过"结果槽 + 微任务泵"桥接：
 *    evaluate() 返回前 QuickJS 会泵完 pending job（testPromise2 已验证），
 *    因此同步返回 '__DRPY_ASYNC__' 后再读 __drpyOutJson() 即拿到终值。
 *
 * 输出统一为 TVBox JSON（class/list/vod_*），前端复用同一套解析。
 */
'use strict';

/* ---------------- 工具 ---------------- */

function __drpyTypeOf(v) {
  return v === null ? 'null' : typeof v;
}

function __drpyStr(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 极简 URL 解析（QuickJS 无 WHATWG URL）：绝对/协议相对/根相对/路径相对 */
function __drpyResolveUrl(base, rel) {
  if (!rel) return rel;
  if (/^https?:\/\//i.test(rel)) return rel;
  if (!base) return rel;
  if (rel.indexOf('//') === 0) {
    return /^https:/i.test(base) ? 'https:' + rel : 'http:' + rel;
  }
  if (/^data:|^blob:|^magnet:/i.test(rel)) return rel;
  var root = base.match(/^(https?:\/\/[^\/?#]+)/i);
  var origin = root ? root[1] : '';
  var pathAndMore = base.slice(origin.length);
  var path = pathAndMore.split('?')[0].split('#')[0] || '/';
  var out;
  if (rel.charAt(0) === '/') {
    out = rel;
  } else {
    var dir = path.slice(0, path.lastIndexOf('/') + 1) || '/';
    var stack = dir.split('/');
    var parts = rel.split('/');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '' || p === '.') continue;
      if (p === '..') { if (stack.length > 1) stack.pop(); continue; }
      stack.push(p);
    }
    out = stack.join('/');
    out = out.replace(/\/{2,}/g, '/'); // 根路径下 stack 会产生多余空段
    if (out.charAt(0) !== '/') out = '/' + out;
  }
  return origin + out;
}

/* ---------------- req（同步 HTTP，桥接 okhttp） ---------------- */

function req(url, options) {
  options = options || {};
  if (typeof url !== 'string' || url.length === 0) throw new Error('req: url 必须是非空字符串');
  var spec = {
    url: url,
    method: (options.method || (options.body !== undefined && options.body !== null ? 'POST' : 'GET') || 'GET'),
    headers: options.headers || options.header || {},
    body: options.body !== undefined && options.body !== null ? __drpyStr(options.body) : null,
    timeout: options.timeout || 15000,
  };
  var res;
  try {
    res = JSON.parse(__req(JSON.stringify(spec)));
  } catch (e) {
    throw new Error('req 内部错误: ' + (e && e.message ? e.message : e));
  }
  if (res && res.__error) throw new Error('req 失败(' + res.code + '): ' + res.__error + ' <- ' + url);
  var body = res && typeof res.body === 'string' ? res.body : '';
  return {
    ok: !!res && res.code >= 200 && res.code < 300,
    code: res ? res.code : 0,
    headers: res ? res.headers || {} : {},
    content: body,
    body: body,
    text: function () { return body; },
    json: function () {
      try { return JSON.parse(body); } catch (e) {
        throw new Error('req.json 解析失败: ' + (e && e.message ? e.message : e));
      }
    },
  };
}

/** 常见便捷写法：post(url, body, headers) */
function post(url, body, headers) {
  return req(url, { method: 'POST', body: body, headers: headers || {} });
}

/* ---------------- pdfa / pdfh / pd（桥接 jsoup） ---------------- */

function __drpyKeyMode(key) {
  if (/^(text|Text)$/i.test(key)) return { mode: 'text' };
  if (/^(html|Html)$/i.test(key)) return { mode: 'html' };
  if (/^(outerHtml|outerhtml)$/i.test(key)) return { mode: 'outerHtml' };
  var ci = key.indexOf(':');
  if (ci > 0) return { mode: 'attr', attr: key.slice(ci + 1) };
  return null; // 非特殊 key（如 'a'、'href'）
}

function __drpyQuery(html, parse, isList) {
  var segs = String(parse).split('&&');
  var key = 'Text';
  var selector;
  if (segs.length === 1) {
    selector = segs[0];
  } else {
    key = segs[segs.length - 1];
    selector = segs.slice(0, -1).join(' ');
  }
  var km = __drpyKeyMode(key);
  var mode, attr = null;
  if (km) {
    mode = km.mode;
    attr = km.attr || null;
  } else if (isList) {
    // pdfa 惯例：末段是标签选择器（'body&&a'），取每个元素 outerHtml
    selector = segs.join(' ');
    mode = 'outerHtml';
  } else {
    // pdfh 惯例：末段是裸属性名（'body&&a&&href'）
    mode = 'attr';
    attr = key;
  }
  return JSON.parse(__domSelect(String(html === undefined || html === null ? '' : html), selector, mode, attr));
}

function pdfa(html, parse) {
  if (typeof parse !== 'string' || parse.trim().length === 0) return [];
  if (parse.indexOf('js:') === 0) {
    try { return eval(parse.slice(3)) || []; } catch (e) { return []; }
  }
  try { return __drpyQuery(html, parse, true); } catch (e) { return []; }
}

function pdfh(html, parse, baseUrl) {
  if (typeof parse !== 'string' || parse.trim().length === 0) return '';
  if (parse.indexOf('js:') === 0) {
    try { return __drpyStr(eval(parse.slice(3))); } catch (e) { return ''; }
  }
  var items;
  try { items = __drpyQuery(html, parse, false); } catch (e) { return ''; }
  var v = items && items.length > 0 ? items[0] : '';
  if (v && baseUrl) v = __drpyResolveUrl(baseUrl, v);
  return v;
}

/** pd = pdfh + 相对地址补全（默认以 rule.host 为 base） */
function pd(html, parse, baseUrl) {
  return pdfh(html, parse, baseUrl || (typeof rule !== 'undefined' && rule.host) || '');
}

/* ---------------- local / log / 编码 ---------------- */

var local = {
  get: function (key, def) {
    var raw = __localGet(String(key));
    if (raw === null || raw === undefined || raw === '') return def;
    return raw;
  },
  set: function (key, value) {
    __localSet(String(key), __drpyStr(value));
  },
};

function log() {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) parts.push(__drpyStr(arguments[i]));
  __log(parts.join(' '));
}

/* ---------------- 规则编排 ---------------- */

var __drpyInited = false;
var __drpyOut = null;

async function __ensureInit() {
  if (__drpyInited) return;
  __drpyInited = true;
  if (typeof rule === 'undefined') throw new Error('规则未定义全局 rule 对象');
  var pre = rule['预处理'] || rule.preProcess || null;
  if (typeof pre === 'function') {
    try { await pre(__drpyExt); } catch (e) { __log('预处理失败(忽略): ' + (e && e.message ? e.message : e)); }
  } else if (typeof pre === 'string' && pre.trim()) {
    try { eval(pre); } catch (e) { __log('预处理失败(忽略): ' + (e && e.message ? e.message : e)); }
  }
}

function __firstOf(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length > 0 ? v[0] : null;
  if (typeof v === 'object' && Array.isArray(v.list)) return v.list.length > 0 ? v.list[0] : null;
  return v;
}

function __normalizeClass(c) {
  if (!c || typeof c !== 'object') return null;
  var id = c.type_id !== undefined ? c.type_id : (c.id !== undefined ? c.id : (c.type !== undefined ? c.type : null));
  var name = c.type_name !== undefined ? c.type_name : (c.name !== undefined ? c.name : null);
  if (id === null || name === null) return null;
  return { type_id: __drpyStr(id), type_name: String(name) };
}

async function __drpyHome() {
  await __ensureInit();
  var classes = [];
  var filters = {};
  var cp = rule['class_parse'];
  if (typeof cp === 'function') {
    var r = await cp();
    if (Array.isArray(r)) {
      classes = r[0] || [];
      filters = r[1] || {};
    } else if (r && typeof r === 'object') {
      classes = r.class || r.classes || [];
      filters = r.filters || r.filter || {};
    }
  } else if (typeof cp === 'string' && cp.trim()) {
    // 老式规则：代码字符串在全局作用域 eval，产出 classes / filter_obj
    globalThis.classes = [];
    globalThis.filter_obj = {};
    try { eval(cp); } catch (e) { __log('class_parse 执行失败: ' + (e && e.message ? e.message : e)); }
    classes = globalThis.classes || [];
    filters = globalThis.filter_obj || {};
  }
  var out = [];
  if (Array.isArray(classes)) {
    for (var i = 0; i < classes.length; i++) {
      var c = __normalizeClass(classes[i]);
      if (c) out.push(c);
    }
  }
  return { class: out, filters: filters || {} };
}

function __drpyList(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object' && Array.isArray(v.list)) return v.list;
  return [];
}

async function __drpyCategory(arg) {
  await __ensureInit();
  var fn = rule['一级'] || rule.category || null;
  if (typeof fn === 'function') {
    var r = await fn(arg.tid, arg.pg, arg.filter === true, arg.extend || {});
    return { list: __drpyList(r), page: arg.pg };
  }
  if (typeof fn === 'string' && fn.trim()) {
    // 老式规则：引擎按 url 模板取页 → eval 一级代码 → 读全局 d
    var urlT = typeof rule.url === 'string' ? rule.url : '';
    var url = urlT.replace(/\{cateId\}/g, encodeURIComponent(arg.tid || ''))
      .replace(/\{catePg\}/g, String(arg.pg || 1))
      .replace(/\{class\}/g, encodeURIComponent(arg.tid || ''))
      .replace(/\{pg\}/g, String(arg.pg || 1));
    var abs = __drpyResolveUrl(typeof rule.host === 'string' ? rule.host : '', url);
    globalThis.html = req(abs).content;
    globalThis.input = globalThis.html;
    globalThis.d = [];
    try { eval(fn); } catch (e) { throw new Error('一级(字符串式)执行失败: ' + (e && e.message ? e.message : e)); }
    return { list: __drpyList(globalThis.d), page: arg.pg };
  }
  throw new Error('规则缺少 一级(category) 定义');
}

async function __drpyDetail(arg) {
  await __ensureInit();
  var fn = rule['二级'] || rule.detail || null;
  if (typeof fn !== 'function') throw new Error('规则缺少 二级(detail) 定义（字符串式不支持）');
  var r = await fn(arg.id, arg.vodFlags || {});
  var vod = __firstOf(r);
  if (!vod || typeof vod !== 'object') throw new Error('二级未返回影片详情');
  return { list: [vod] };
}

async function __drpySearch(arg) {
  await __ensureInit();
  var fn = rule['搜索'] || rule.search || null;
  if (typeof fn === 'function') {
    var r = await fn(arg.wd, arg.quick === true);
    return { list: __drpyList(r) };
  }
  if (typeof fn === 'string' && fn.trim()) {
    var urlT = typeof rule.searchUrl === 'string' ? rule.searchUrl : '';
    var url = urlT.replace(/\{wd\}/g, encodeURIComponent(arg.wd || ''))
      .replace(/\{pg\}/g, String(arg.pg || 1));
    var abs = __drpyResolveUrl(typeof rule.host === 'string' ? rule.host : '', url);
    globalThis.html = req(abs).content;
    globalThis.input = arg.wd || '';
    globalThis.d = [];
    try { eval(fn); } catch (e) { throw new Error('搜索(字符串式)执行失败: ' + (e && e.message ? e.message : e)); }
    return { list: __drpyList(globalThis.d) };
  }
  throw new Error('规则缺少 搜索(search) 定义');
}

async function __drpyPlay(arg) {
  await __ensureInit();
  // 优先 lazy；无 lazy 且 play_parse=false 时 id 即直链
  var fn = rule['lazy'] || rule.lazy || null;
  if (typeof fn === 'function') {
    var r = await fn(arg.flag, arg.id);
    if (typeof r === 'string') return { parse: 0, url: r };
    if (r && typeof r === 'object') {
      return {
        parse: r.parse ? 1 : 0,
        url: __drpyStr(r.url !== undefined ? r.url : r.playUrl),
        jx: r.jx ? __drpyStr(r.jx) : '',
        playUrl: r.playUrl ? __drpyStr(r.playUrl) : '',
        header: r.header || r.headers || {},
      };
    }
    throw new Error('lazy 未返回播放地址');
  }
  if (typeof fn === 'string' && fn.trim()) {
    // 老式 lazy：代码字符串操作全局 input，产出直链
    globalThis.flag = arg.flag || '';
    globalThis.input = arg.id || '';
    try { eval(fn); } catch (e) { throw new Error('lazy(字符串式)执行失败: ' + (e && e.message ? e.message : e)); }
    var out = __drpyStr(globalThis.input);
    if (!out) throw new Error('lazy(字符串式)未产出播放地址');
    return { parse: 0, url: out };
  }
  var playParse = rule['play_parse'] === true || rule.play_parse === true;
  if (!playParse) return { parse: 0, url: __drpyStr(arg.id), header: {} };
  throw new Error('规则开启了 play_parse 但缺少 lazy 定义');
}

/* ---------------- 同步桥接入口 ---------------- */

/**
 * Java 侧唯一入口：统一走异步结果槽（规则函数同步/异步混合，await 归一）。
 * 返回恒为 '__DRPY_ASYNC__'，Java 随后调 __drpyOutJson() 取终值——
 * evaluate 返回前 QuickJS 已泵完微任务队列，正常拿到终值；
 * 若规则在微任务里挂起（如 await 一个永不 resolve 的 Promise），__drpyOutJson
 * 返回明确的超时错误而不是挂死原生线程。
 */
function __drpyCall(method, argJson) {
  var arg = {};
  try { arg = JSON.parse(argJson || '{}'); } catch (e) { /* 保持空参数 */ }
  __drpyOut = { state: 'pending' };
  (async function () {
    try {
      var r;
      switch (method) {
        case 'home': r = await __drpyHome(); break;
        case 'category': r = await __drpyCategory(arg); break;
        case 'detail': r = await __drpyDetail(arg); break;
        case 'search': r = await __drpySearch(arg); break;
        case 'play': r = await __drpyPlay(arg); break;
        default: throw new Error('未知的 drpy 方法: ' + method);
      }
      __drpyOut = { state: 'done', value: JSON.stringify(r === undefined ? null : r) };
    } catch (e) {
      __drpyOut = { state: 'done', value: JSON.stringify({ __error: e && e.message ? e.message : String(e) }) };
    }
  })();
  return '__DRPY_ASYNC__';
}

function __drpyOutJson() {
  if (!__drpyOut) return JSON.stringify({ __error: '无异步结果' });
  if (__drpyOut.state === 'pending') return JSON.stringify({ __error: '异步规则执行超时（微任务未完成）' });
  return __drpyOut.value;
}
