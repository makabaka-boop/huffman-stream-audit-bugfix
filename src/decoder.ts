import { bitAt, parseHexBlocks } from "./bitstream.js";
import { DecodeFailure, fail, type ErrorInfo } from "./errors.js";
import {
  EOS,
  MAX_LENGTH,
  MAX_SYMBOLS,
  MIN_LENGTH,
  MIN_SYMBOLS,
  buildCodeTable,
  isValidSymbolName,
  type CodeEntry,
  type SymbolLength,
} from "./symbols.js";

/** 一个符号在比特流中的位置：[start, end)，end 为开区间（= start + 码长）。 */
export interface Span {
  symbol: string;
  start: number;
  end: number;
}

export interface CodeTableEntry {
  symbol: string;
  length: number;
  code: string;
}

export interface DecodeSuccess {
  ok: true;
  /** 解码出的符号序列，最后一个必为 EOS */
  symbols: string[];
  /** 每个符号的起止全局位偏移 [start, end) */
  spans: Span[];
  /** 按规范顺序重建的码表 */
  codeTable: CodeTableEntry[];
  totalBits: number;
}

export interface DecodeErrorResult {
  ok: false;
  error: ErrorInfo;
}

export type DecodeResult = DecodeSuccess | DecodeErrorResult;

interface ParsedInput {
  symbols: SymbolLength[];
  blocks: unknown;
  totalBits: unknown;
}

/** 解码入口：任何失败都以 { ok: false, error } 整份返回，绝不部分输出。 */
export function decode(input: unknown): DecodeResult {
  try {
    return decodeOrThrow(input);
  } catch (err) {
    if (err instanceof DecodeFailure) return { ok: false, error: err.info };
    throw err;
  }
}

function decodeOrThrow(input: unknown): DecodeSuccess {
  const spec = parseInput(input);
  const table = buildCodeTable(spec.symbols);
  const bytes = parseHexBlocks(spec.blocks);
  const totalBits = Number(spec.totalBits);
  const spans = decodeSpans(bytes, totalBits, table);
  return {
    ok: true,
    symbols: spans.map((s) => s.symbol),
    spans,
    codeTable: table.map(({ symbol, length, code }) => ({ symbol, length, code })),
    totalBits,
  };
}

function parseInput(input: unknown): ParsedInput {
  const root = input as Record<string, any>;
  const rawSymbols = root.symbols as Array<Record<string, unknown>>;
  const symbols: SymbolLength[] = rawSymbols.map((entry) => ({
    symbol: String(entry.symbol),
    length: Number(entry.length),
  }));
  return {
    symbols,
    blocks: root.bitstream.blocks,
    totalBits: root.bitstream.totalBits,
  };
}

function decodeSpans(bytes: Uint8Array, totalBits: number, table: CodeEntry[]): Span[] {
  const byCode = new Map(table.map((e) => [e.code, e.symbol]));
  const maxLength = Math.max(...table.map((e) => e.length));
  const spans: Span[] = [];
  let start = 0;
  let code = "";
  for (let pos = 0; pos < totalBits; pos++) {
    code += bitAt(bytes, pos);
    const symbol = byCode.get(code);
    if (symbol !== undefined) {
      spans.push({ symbol, start, end: pos + 1 });
      if (symbol === EOS) return spans;
      start = pos + 1;
      code = "";
    } else if (code.length >= maxLength) {
      fail("NO_VALID_PREFIX", "invalid codeword", pos);
    }
  }
  return spans;
}
