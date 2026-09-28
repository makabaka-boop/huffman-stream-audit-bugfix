import { fail } from "./errors.js";

/** 保留符号名：消息结束标记。普通符号是单个 ASCII 字符，不会与之冲突。 */
export const EOS = "EOS";

export const MIN_SYMBOLS = 2;
export const MAX_SYMBOLS = 64;
export const MIN_LENGTH = 1;
export const MAX_LENGTH = 15;

export interface SymbolLength {
  symbol: string;
  length: number;
}

export interface CodeEntry {
  symbol: string;
  length: number;
  /** 码字值（右对齐的整数） */
  value: number;
  /** 码字的 0/1 字符串，长度恰为 length */
  code: string;
}

/** 合法符号名：保留字 "EOS"，或单个 ASCII 字符（U+0000..U+007F）。 */
export function isValidSymbolName(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (s === EOS) return true;
  if ([...s].length !== 1) return false;
  return s.codePointAt(0)! <= 0x7f;
}

export function utf8Bytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

export function compareByteArrays(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/**
 * 规范顺序：先按码长升序，同码长内按符号名的 UTF-8 字节序。
 * （"EOS" 作为符号名同样取其 UTF-8 字节参与排序。）
 */
export function canonicalOrder(entries: SymbolLength[]): SymbolLength[] {
  return [...entries].sort((x, y) => x.length - y.length);
}

/**
 * 从长度表按固定顺序重建规范码表：按规范顺序遍历符号，
 * 码字从 0 开始连续分配，码长增加时左移。
 * 若某一步码字值超出当前码长可表示的范围，则长度表违反 Kraft 不等式，
 * 即超额订码（OVERSUBSCRIBED）。允许 Kraft 和 < 1 的不完整码表。
 */
export function buildCodeTable(entries: SymbolLength[]): CodeEntry[] {
  const sorted = canonicalOrder(entries);
  let value = 0;
  let previous = 0;
  return sorted.map(({ symbol, length }) => {
    value <<= length - previous;
    const item = { symbol, length, value, code: value.toString(2).padStart(length, "0") };
    value++;
    previous = length;
    return item;
  });
}
