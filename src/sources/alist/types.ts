/**
 * AList API 类型（v3）
 *
 * 仅声明用到的字段，其余忽略；服务端返回的字段大多可空。
 */
export interface AlistResponse<T> {
  code: number;
  message: string;
  data: T;
}

export interface AlistLoginData {
  token: string;
}

export interface AlistFsItem {
  name: string;
  size: number;
  is_dir: boolean;
  modified: string;
  created: string;
  sign: string;
  thumb: string;
  type: number;
  hashinfo?: string;
  hash_info?: string | null;
}

export interface AlistListData {
  content: AlistFsItem[] | null;
  total: number;
  readme?: string;
  header?: string;
  write?: boolean;
  provider?: string;
}

export interface AlistGetData {
  name: string;
  size: number;
  is_dir: boolean;
  modified: string;
  created: string;
  sign: string;
  thumb: string;
  type: number;
  raw_url: string;
  /** 直链（部分后端字段名为 url，需兼容） */
  url?: string;
}

/** ext 字段（源配置）中 AList 相关键 */
export interface AlistExt {
  username?: string | null;
  password?: string | null;
  token?: string | null;
  /** 根目录，如 '/Movies' */
  root?: string | null;
}

/** AList 登录响应 code === 200 为成功 */
export const ALIST_OK = 200;
