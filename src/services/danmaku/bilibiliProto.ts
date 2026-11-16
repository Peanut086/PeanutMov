/**
 * B 站分片弹幕 protobuf 解码（纯函数）
 *
 * `x/v2/dm/web/seg.so` 回 `DmSegMobileReply { repeated Dm elems = 1 }`，`Dm` 里只用得到
 * 2=时间(毫秒)、3=模式、5=颜色、7=文本，其余（pid/rowid/ctime…）一律跳过。
 * 顶层还带 4/5 两个配置字段（弹幕描边贴图 URL 之类），与弹幕无关，直接忽略。
 *
 * 越界分片（`Bili-Status-Code: -304`）与频控（`-352`）都是近乎空的响应体，
 * 这里统一返回空数组，由调用方按「该片没有弹幕」处理。
 */
import type { DanmakuComment } from '@/types';

import { modeOf } from './bilibiliXml';

const WIRE_VARINT = 0;
const WIRE_FIXED32 = 5;
const WIRE_LENGTH_DELIMITED = 2;

/** DmSegMobileReply 里弹幕数组的字段号 */
const FIELD_ELEMS = 1;
const FIELD_TIME_MS = 2;
const FIELD_MODE = 3;
const FIELD_COLOR = 5;
const FIELD_TEXT = 7;

const textDecoder = new TextDecoder();

type PbValue = number | Uint8Array;

/** varint 累加用乘法而不是 `<<`：超过 2^31 的值（oid 等）在 JS 位运算下会溢出成低 32 位 */
function readVarint(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < bytes.length) {
    const byte = bytes[cursor] ?? 0;
    value += (byte & 0x7f) * 2 ** shift;
    cursor += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    // 畸形数据兜底：10 组之后不再前推，免得整片解析被一个坏偏移带偏
    if (shift > 70) break;
  }
  return [value, cursor];
}

/** 顺序解出一条消息的所有字段；遇到无法跳过的 wire 类型（group）即停止，返回已解出的部分 */
function readFields(bytes: Uint8Array): Array<{ field: number; value: PbValue }> {
  const out: Array<{ field: number; value: PbValue }> = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 0;
  while (cursor < bytes.length) {
    let tag: number;
    [tag, cursor] = readVarint(bytes, cursor);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 0) break;
    if (wire === WIRE_VARINT) {
      let value: number;
      [value, cursor] = readVarint(bytes, cursor);
      out.push({ field, value });
    } else if (wire === WIRE_LENGTH_DELIMITED) {
      let length: number;
      [length, cursor] = readVarint(bytes, cursor);
      out.push({ field, value: bytes.subarray(cursor, cursor + length) });
      cursor += length;
    } else if (wire === WIRE_FIXED32) {
      out.push({ field, value: view.getUint32(cursor, true) });
      cursor += 4;
    } else {
      break;
    }
    if (cursor > bytes.length) break;
  }
  return out;
}

function numberField(fields: Array<{ field: number; value: PbValue }>, field: number): number | null {
  const hit = fields.find((item) => item.field === field);
  return typeof hit?.value === 'number' ? hit.value : null;
}

function textField(fields: Array<{ field: number; value: PbValue }>, field: number): string {
  const hit = fields.find((item) => item.field === field);
  if (!(hit?.value instanceof Uint8Array)) return '';
  return textDecoder.decode(hit.value).trim();
}

/** 分片响应体 → 弹幕列表；空体/频控体返回 [] */
export function parseSegmentReply(bytes: Uint8Array): DanmakuComment[] {
  if (bytes.length === 0) return [];
  const out: DanmakuComment[] = [];
  for (const elem of readFields(bytes)) {
    if (elem.field !== FIELD_ELEMS || !(elem.value instanceof Uint8Array)) continue;
    const fields = readFields(elem.value);
    const timeMs = numberField(fields, FIELD_TIME_MS);
    const text = textField(fields, FIELD_TEXT);
    if (timeMs === null || text.length === 0) continue;
    out.push({
      time: timeMs / 1000,
      mode: modeOf(numberField(fields, FIELD_MODE) ?? 1),
      color: numberField(fields, FIELD_COLOR) ?? 0xffffff,
      text,
    });
  }
  return out;
}
