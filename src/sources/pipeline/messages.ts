/**
 * 管道用户文案（与既有 SiteAdapter 文案逐字一致）
 *
 * 单独成文件是为了让规则包、解析器、适配器引用同一常量，避免文案漂移。
 */
export const UNSUPPORTED_FORMAT_MESSAGE = '该地址返回的不是订阅 JSON，可能是网页地址或已被拦截';
export const NOT_TVBOX_MESSAGE = '该地址返回的 JSON 不是 TVBox 订阅格式（缺少 list/class 字段）';
/** 网页播放页里没找到可播地址时的用户文案 */
export const PLAY_PAGE_NOT_FOUND_MESSAGE = '该源返回的是网页播放页，未找到可播放地址';
