/**
 * drpy 宿主环境（CHG-16）—— 在 QuickJS 内执行的预置脚本
 *
 * 职责：
 * 1. 基于原生同步绑定（__req/__domSelect/__log/__localGet/__localSet/__b64e/__b64d/__md5）
 *    实现 drpy 规则依赖的全局 API；
 * 2. 编排规则对象 `rule`，对外只暴露 `__drpyCall(method, argJson)` 一个同步入口；
 * 3. 兼容两种规则形态：
 *    a. drpy2 ES6 函数式（class_parse/一级/二级/搜索/lazy 为函数，可 async/await）；
 *    b. drpy2 代码串式（`js:` 前缀字符串 + request/setResult/VODS 约定、
 *       `{{fl.x}}` 模板 URL、fypage/fyclass/fyfilter、UA 常量），
 *       语义对齐官方 drpy2.min.js 3.9.x 的 categoryParse/searchParse/
 *       detailParse/playParse（extracted 2026-10-24）。
 * 4. 异步统一走"结果槽 + 微任务泵"桥接：evaluate() 返回前 QuickJS 泵完
 *    pending job，同步返回 '__DRPY_ASYNC__' 后再读 __drpyOutJson() 即终值。
 *
 * 输出统一为 TVBox JSON（class/list/vod_*），前端复用同一套解析。
 */
'use strict';

/* ---------------- 工具 ---------------- */

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

/** 极简 jinja2：{{ a.b.c }} 点路径取值（drpy2 的 filter_url 模板） */
function __drpyJinja2(tpl, ctx) {
  return String(tpl).replace(/\{\{([^}]+)\}\}/g, function (_, expr) {
    var v = ctx;
    var parts = expr.trim().split('.');
    for (var i = 0; i < parts.length; i++) {
      if (v === null || v === undefined) return '';
      v = v[parts[i]];
    }
    return v === null || v === undefined ? '' : String(v);
  });
}

/** fypage 处理：`(2*fypage - 1)` 一类表达式按 drpy2 约定求值 */
function __drpyApplyFypage(url, pg) {
  if (!/fypage/.test(url)) return url;
  if (url.indexOf('(') >= 0 && url.indexOf(')') >= 0) {
    var m = url.match(/.*?\((.*)\)/);
    if (m) {
      var rep = m[1].replace(/fypage/g, String(pg));
      var val;
      try { val = eval(rep); } catch (e) { val = pg; }
      url = url.replace(m[1], String(val)).replace(/\(/g, '').replace(/\)/g, '');
      return url;
    }
  }
  return url.replace(/fypage/g, String(pg));
}

/* ---------------- UA 常量与 request（对齐 drpy2 全局） ---------------- */

var MOBILE_UA = 'Mozilla/5.0 (Linux; Android 11; M2007J3SC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/77.0.3865.120 Mobile Safari/537.36';
var PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.54 Safari/537.36';
var UA = MOBILE_UA;

function __drpyResolveHeaders(headers) {
  var out = {};
  var src = headers || {};
  for (var k in src) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    var v = src[k];
    if (v === 'MOBILE_UA') v = MOBILE_UA;
    else if (v === 'PC_UA') v = PC_UA;
    else if (v === 'UA') v = UA;
    out[k] = __drpyStr(v);
  }
  return out;
}

/** req(url, options) → {ok, code, headers, content, json()}：底层 HTTP（桥接 __req） */
function req(url, options) {
  options = options || {};
  if (typeof url !== 'string' || url.length === 0) throw new Error('req: url 必须是非空字符串');
  var spec = {
    url: url,
    method: (options.method || (options.body !== undefined && options.body !== null ? 'POST' : 'GET') || 'GET'),
    headers: options.headers || {},
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

/** request(url, obj) → 响应体字符串（合并 rule.headers，UA 别名替换） */
function request(url, obj) {
  obj = obj || {};
  var headers = __drpyResolveHeaders(typeof rule !== 'undefined' ? rule.headers : null);
  if (obj.headers) {
    var extra = __drpyResolveHeaders(obj.headers);
    for (var k in extra) headers[k] = extra[k];
  }
  var res = req(url, {
    method: obj.method || (obj.body !== undefined && obj.body !== null ? 'POST' : 'GET'),
    headers: headers,
    body: obj.body,
    timeout: obj.timeout || 15000,
  });
  return res.content;
}

/** post(url, obj) → drpy2 约定：obj={body, headers?}，返回响应体字符串 */
function post(url, obj) {
  obj = obj || {};
  return request(url, { method: 'POST', body: obj.body, headers: obj.headers });
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

/** pd = pdfh + 相对地址补全（默认以 MY_URL/rule.host 为 base） */
function pd(html, parse, baseUrl) {
  return pdfh(html, parse, baseUrl || (typeof MY_URL === 'string' && MY_URL) || (typeof rule !== 'undefined' && rule.host) || '');
}

/* ---------------- local / log / 编码（drpy2 别名一并提供） ---------------- */

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
function getItem(key, def) { return local.get(key, def); }
function setItem(key, val) { local.set(key, val); }

function log() {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) parts.push(__drpyStr(arguments[i]));
  __log(parts.join(' '));
}
var print = log;

function base64Encode(s) { return __b64e(__drpyStr(s)); }
function base64Decode(s) { return __b64d(__drpyStr(s)); }
function md5(s) { return __md5(__drpyStr(s)); }

/* ---------------- drpy2 结果归一（setResult/VODS 约定） ---------------- */

var VODS = [];
var VOD = null;

/** {url,title,desc,content,pic_url,img,...} → TVBox vod_* 字段，写入全局 VODS */
function setResult(d) {
  if (!Array.isArray(d)) return [];
  VODS = [];
  d.forEach(function (it) {
    if (!it || typeof it !== 'object') return;
    var obj = {
      vod_id: it.url !== undefined && it.url !== null ? __drpyStr(it.url) : __drpyStr(it.vod_id),
      vod_name: __drpyStr(it.title !== undefined ? it.title : it.vod_name),
      vod_remarks: __drpyStr(it.desc !== undefined ? it.desc : it.vod_remarks),
      vod_content: __drpyStr(it.content !== undefined ? it.content : it.vod_content),
      vod_pic: __drpyStr(it.pic_url !== undefined ? it.pic_url : (it.img !== undefined ? it.img : it.vod_pic)),
    };
    if (it.tname !== undefined) obj.type_name = __drpyStr(it.tname);
    if (it.tid !== undefined) obj.type_id = __drpyStr(it.tid);
    if (it.year !== undefined) obj.vod_year = __drpyStr(it.year);
    if (it.actor !== undefined) obj.vod_actor = __drpyStr(it.actor);
    if (it.director !== undefined) obj.vod_director = __drpyStr(it.director);
    if (it.area !== undefined) obj.vod_area = __drpyStr(it.area);
    VODS.push(obj);
  });
  return VODS;
}
function setResult2(res) { VODS = (res && res.list) || []; return VODS; }
function setHomeResult(res) { return setResult(res && res.list); }

/** 简化版 jx 判定：不维护解析站清单，一律返回 0（parse 仍由前端嗅探兜底） */
function tellIsJx() { return 0; }

/* ---------------- 引擎状态 ---------------- */

var __drpyInited = false;
var __drpyOut = null;
var MY_URL = '';
var input = '';
var MY_PAGE = 1;
var MY_FL = {};
var MY_CATE = '';
var TYPE = '';
var KEY = '';
var detailUrl = '';

async function __ensureInit() {
  if (__drpyInited) return;
  __drpyInited = true;
  if (typeof rule === 'undefined') throw new Error('规则未定义全局 rule 对象');
  var pre = rule['预处理'] || rule.preProcess || null;
  if (typeof pre === 'function') {
    try { await pre(__drpyExt); } catch (e) { __log('预处理失败(忽略): ' + (e && e.message ? e.message : e)); }
  } else if (typeof pre === 'string' && pre.trim()) {
    try { eval(pre.trim().replace('js:', '')); } catch (e) { __log('预处理失败(忽略): ' + (e && e.message ? e.message : e)); }
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

function __normalizeVodList(list) {
  var out = [];
  if (Array.isArray(list)) {
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || typeof it !== 'object') continue;
      // 函数式规则可能已给 vod_* 字段；代码串式给 url/title
      if (it.vod_id !== undefined || it.vod_name !== undefined) {
        out.push({
          vod_id: __drpyStr(it.vod_id),
          vod_name: __drpyStr(it.vod_name),
          vod_pic: __drpyStr(it.vod_pic),
          vod_remarks: __drpyStr(it.vod_remarks),
          vod_content: __drpyStr(it.vod_content),
          vod_year: __drpyStr(it.vod_year),
          vod_area: __drpyStr(it.vod_area),
        });
      } else {
        out.push({
          vod_id: __drpyStr(it.url),
          vod_name: __drpyStr(it.title),
          vod_pic: __drpyStr(it.pic_url || it.img),
          vod_remarks: __drpyStr(it.desc),
          vod_content: __drpyStr(it.content),
          vod_year: __drpyStr(it.year),
        });
      }
    }
  }
  return out;
}

/* ---------------- home ---------------- */

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
    // drpy2 解析串：'列表选择器;片名;链接[;第4段处理]'，分号分隔
    var p = cp.split(';');
    var host2 = __drpyResolveUrl(__drpyStr(rule.host), __drpyStr(rule.url || ''));
    try {
      var html = request(host2);
      if (html && p.length >= 3) {
        var list = pdfa(html, p[0]);
        for (var i = 0; i < list.length; i++) {
          var it = list[i];
          var name = pdfh(it, p[1]).replace(/\n|\t/g, '').trim();
          var url = pd(it, p[2], host2);
          if (name) classes.push({ type_id: url, type_name: name });
        }
      }
    } catch (e) { __log('class_parse 执行失败: ' + (e && e.message ? e.message : e)); }
  } else if (rule.class_name && rule.class_url) {
    // 静态分类串：'名称1&名称2' + '链接1&链接2'
    var names = String(rule.class_name).split('&');
    var urls = String(rule.class_url).split('&');
    var cnt = Math.min(names.length, urls.length);
    for (var j = 0; j < cnt; j++) classes.push({ type_id: urls[j], type_name: names[j] });
  }
  if (rule.cate_exclude) {
    var re = new RegExp(rule.cate_exclude);
    classes = classes.filter(function (c) { return !re.test(c.type_name); });
  }
  var out = [];
  for (var k = 0; k < classes.length; k++) {
    var c = __normalizeClass(classes[k]);
    if (c) out.push(c);
  }
  if (rule.filter) filters = rule.filter;
  return { class: out, filters: filters || {} };
}

/* ---------------- 分类 url 组装（drpy2 fyclass/fyfilter/filter_def 约定） ---------------- */

function __drpyBuildCateUrl(tid, pg, extend, useFilter) {
  var url = __drpyStr(rule.url || '');
  url = url.replace(/fyclass/g, tid);
  if (pg === 1 && url.indexOf('[') >= 0 && url.indexOf(']') >= 0) {
    url = url.split('[')[1].split(']')[0];
  } else if (pg > 1 && url.indexOf('[') >= 0 && url.indexOf(']') >= 0) {
    url = url.split('[')[0];
  }
  if (useFilter && rule.filter_url) {
    if (!/fyfilter/.test(url)) {
      if (!url.slice(-1) === '&') { /* noop */ }
      if (url.charAt(url.length - 1) !== '&' && rule.filter_url.charAt(0) !== '&') url += '&';
      url += rule.filter_url;
    } else {
      url = url.replace('fyfilter', rule.filter_url);
    }
    var fl = extend || {};
    if (rule.filter_def && typeof rule.filter_def === 'object' && rule.filter_def[tid]) {
      var merged = {};
      for (var dk in rule.filter_def[tid]) merged[dk] = rule.filter_def[tid][dk];
      for (var ek in fl) merged[ek] = fl[ek];
      fl = merged;
    }
    url = __drpyJinja2(url, { fl: fl });
  }
  url = __drpyApplyFypage(url, pg);
  return __drpyResolveUrl(__drpyStr(rule.host || ''), url);
}

/* ---------------- category ---------------- */

async function __drpyCategory(arg) {
  await __ensureInit();
  var fn = rule['一级'] || rule.category || null;
  if (typeof fn === 'function') {
    var r = await fn(arg.tid, arg.pg, arg.filter === true, arg.extend || {});
    return { list: __normalizeVodList(__drpyList(r)), page: arg.pg };
  }
  if (typeof fn === 'string' && fn.trim()) {
    // drpy2 categoryParse：js: 代码串约定（input=MY_URL, MY_PAGE, MY_FL → VODS）
    var url = __drpyBuildCateUrl(arg.tid, arg.pg, arg.extend, true);
    MY_URL = url;
    MY_CATE = arg.tid;
    MY_PAGE = arg.pg;
    MY_FL = arg.extend || {};
    TYPE = 'cate';
    input = MY_URL;
    VODS = [];
    try { eval(fn.trim().replace('js:', '')); } catch (e) { throw new Error('一级执行失败: ' + (e && e.message ? e.message : e)); }
    var d = VODS;
    if (rule.图片来源 && Array.isArray(d)) {
      d.forEach(function (it) {
        if (it.vod_pic && /^http/.test(it.vod_pic)) it.vod_pic += rule.图片来源;
      });
    }
    return { list: d, page: arg.pg };
  }
  throw new Error('规则缺少 一级(category) 定义');
}

/* ---------------- detail ---------------- */

async function __drpyDetail(arg) {
  await __ensureInit();
  var fn = rule['二级'] || rule.detail || null;
  var vod;
  if (fn === '*') {
    // drpy2 约定：一级直出链接，无二级
    var orId = __drpyStr(arg.id);
    var extra = orId.split('@@');
    vod = {
      vod_id: extra[0] || orId,
      vod_name: extra.length > 1 ? extra[1] : '片名',
      vod_pic: extra.length > 2 ? extra[2] : '',
      vod_remarks: orId,
      vod_content: extra[0] || orId,
      vod_play_from: '道长在线',
      vod_play_url: '嗅探播放$' + (extra[0] || orId),
    };
    return { list: [vod] };
  }
  if (typeof fn === 'function') {
    var r = await fn(arg.id, arg.vodFlags || {});
    vod = __firstOf(r);
    if (!vod || typeof vod !== 'object') throw new Error('二级未返回影片详情');
    return { list: [vod] };
  }
  if (typeof fn === 'string' && fn.trim().indexOf('js:') === 0) {
    // drpy2 detailParse：TYPE='detail', input=MY_URL → 全局 VOD
    MY_URL = __drpyStr(arg.id);
    TYPE = 'detail';
    input = MY_URL;
    var play_url = '';
    VOD = null;
    try { eval(fn.trim().replace('js:', '')); } catch (e) { throw new Error('二级执行失败: ' + (e && e.message ? e.message : e)); }
    vod = VOD;
    if (!vod || typeof vod !== 'object') throw new Error('二级未产出 VOD');
    return { list: [vod] };
  }
  throw new Error('规则缺少 二级(detail) 定义（选择器对象式不支持）');
}

/* ---------------- search ---------------- */

async function __drpySearch(arg) {
  await __ensureInit();
  var fn = rule['搜索'] || rule.search || null;
  if (fn === '*' && (typeof rule['一级'] === 'string' || typeof rule['一级'] === 'function')) {
    fn = rule['一级'];
  }
  if (typeof fn === 'function') {
    var r = await fn(arg.wd, arg.quick === true);
    return { list: __normalizeVodList(__drpyList(r)) };
  }
  if (typeof fn === 'string' && fn.trim()) {
    var searchUrl = __drpyStr(rule.searchUrl || '');
    if (!searchUrl) throw new Error('规则缺少 searchUrl');
    var url = searchUrl.replace(/\*\*/g, arg.wd || '');
    if (arg.pg === 1 && url.indexOf('[') >= 0 && url.indexOf(']') >= 0 && url.indexOf('#') < 0) {
      url = url.split('[')[1].split(']')[0];
    } else if (arg.pg > 1 && url.indexOf('[') >= 0 && url.indexOf(']') >= 0 && url.indexOf('#') < 0) {
      url = url.split('[')[0];
    }
    url = __drpyApplyFypage(url, arg.pg);
    MY_URL = __drpyResolveUrl(__drpyStr(rule.host || ''), url);
    TYPE = 'search';
    MY_PAGE = arg.pg;
    KEY = arg.wd || '';
    input = MY_URL;
    detailUrl = __drpyStr(rule.detailUrl || '');
    VODS = [];
    try { eval(fn.trim().replace('js:', '')); } catch (e) { throw new Error('搜索执行失败: ' + (e && e.message ? e.message : e)); }
    return { list: VODS };
  }
  throw new Error('规则缺少 搜索(search) 定义');
}

/* ---------------- play ---------------- */

async function __drpyPlay(arg) {
  await __ensureInit();
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
    // drpy2 playParse：input=播放页地址 → eval 后 input 可能被改写为直链或 {parse,url} 对象
    var playUrl = __drpyStr(arg.id);
    if (!/http/.test(playUrl)) {
      try { playUrl = base64Decode(playUrl); } catch (e) { /* 非编码地址原样用 */ }
    }
    try { playUrl = decodeURIComponent(playUrl); } catch (e) { /* 保留原文 */ }
    MY_URL = playUrl;
    input = playUrl;
    try { eval(fn.replace('js:', '').trim()); } catch (e) { throw new Error('lazy 执行失败: ' + (e && e.message ? e.message : e)); }
    if (input && typeof input === 'object') {
      return {
        parse: input.parse ? 1 : 0,
        url: __drpyStr(input.url !== undefined ? input.url : input.playUrl),
        jx: input.jx ? __drpyStr(input.jx) : '',
        playUrl: input.playUrl ? __drpyStr(input.playUrl) : '',
        header: input.header || input.headers || {},
      };
    }
    var out = __drpyStr(input);
    if (!out) throw new Error('lazy 未产出播放地址');
    return { parse: 1, url: out, jx: String(tellIsJx(out)), header: {} };
  }
  var playParse = rule['play_parse'] === true || rule.play_parse === true;
  if (!playParse) return { parse: 0, url: __drpyStr(arg.id), header: {} };
  throw new Error('规则开启了 play_parse 但缺少 lazy 定义');
}

function __drpyList(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object' && Array.isArray(v.list)) return v.list;
  return [];
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
