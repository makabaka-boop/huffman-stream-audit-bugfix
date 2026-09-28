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
  totalBits: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPositiveLengthInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * 输入结构校验。任何不符合格式约定的输入都以 INVALID_INPUT 整份拒绝
 * （bitOffset 与比特流无关，记 null），绝不依赖下游抛未封装异常。
 */
function parseInput(input: unknown): ParsedInput {
  if (!isPlainObject(input)) {
    fail("INVALID_INPUT", "input must be a JSON object", null);
  }
  const { symbols: rawSymbols, bitstream: rawBitstream } = input;

  if (!Array.isArray(rawSymbols)) {
    fail("INVALID_INPUT", "symbols must be an array", null);
  }
  if (rawSymbols.length < MIN_SYMBOLS || rawSymbols.length > MAX_SYMBOLS) {
    fail(
      "INVALID_INPUT",
      `symbols must contain between ${MIN_SYMBOLS} and ${MAX_SYMBOLS} entries`,
      null,
    );
  }

  const symbols: SymbolLength[] = [];
  const seen = new Set<string>();
  for (const entry of rawSymbols) {
    if (!isPlainObject(entry)) {
      fail("INVALID_INPUT", "each symbol entry must be an object", null);
    }
    const { symbol, length } = entry;
    if (!isValidSymbolName(symbol)) {
      fail(
        "INVALID_INPUT",
        `symbol name must be "EOS" or a single ASCII character, got ${JSON.stringify(symbol)}`,
        null,
      );
    }
    if (!isPositiveLengthInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
      fail(
        "INVALID_INPUT",
        `symbol length must be an integer in [${MIN_LENGTH}, ${MAX_LENGTH}], got ${JSON.stringify(length)}`,
        null,
      );
    }
    if (seen.has(symbol)) {
      fail("INVALID_INPUT", `duplicate symbol ${JSON.stringify(symbol)}`, null);
    }
    seen.add(symbol);
    symbols.push({ symbol, length });
  }

  if (!isPlainObject(rawBitstream)) {
    fail("INVALID_INPUT", "bitstream must be an object", null);
  }
  const { blocks, totalBits } = rawBitstream;
  // blocks 自身的元素结构由 parseHexBlocks 逐块校验。
  if (!Array.isArray(blocks)) {
    fail("INVALID_INPUT", "bitstream.blocks must be an array of hex strings", null);
  }
  if (!isPositiveLengthInteger(totalBits) || totalBits < 0) {
    fail("INVALID_INPUT", "bitstream.totalBits must be a non-negative integer", null);
  }

  return { symbols, blocks, totalBits };
}

/** 解码入口：任何失败都以 { ok: false, error } 整份返回，绝不部分输出。 */
export function decode(input: unknown): DecodeResult {
  try {
    return decodeOrThrow(input);
  } catch (err) {
    if (err instanceof DecodeFailure) return { ok: false, error: err.info };
    // 兜底：校验已覆盖所有已知非法结构，这里保证任何意外异常也不会逃逸
    // 为未封装错误（例如未来改动引入的 TypeError）。
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: err instanceof Error ? err.message : String(err),
        bitOffset: null,
      },
    };
  }
}

function decodeOrThrow(input: unknown): DecodeSuccess {
  const spec = parseInput(input);

  // 码表阶段：超额订码（@0）优先于缺 EOS（@0）。
  const table = buildCodeTable(spec.symbols);
  if (!table.some((e) => e.symbol === EOS)) {
    fail("MISSING_EOS", "code table does not contain the EOS symbol", 0);
  }

  // 比特流结构阶段：块格式在 parseHexBlocks 内校验；
  // 声明有效位超过实际传输位按结构问题处理，记实际可用位数。
  const bytes = parseHexBlocks(spec.blocks);
  const totalBits = spec.totalBits;
  const availableBits = bytes.length * 8;
  if (totalBits > availableBits) {
    fail(
      "BITSTREAM_TOO_SHORT",
      `declared ${totalBits} valid bits but only ${availableBits} were transmitted`,
      availableBits,
    );
  }

  const spans = decodeSpans(bytes, totalBits, table);

  // EOS 已找到；其后仍有有效位 → EXTRA_BITS 先于填充位检查。
  const eosEnd = spans[spans.length - 1]!.end;
  if (eosEnd < totalBits) {
    fail("EXTRA_BITS", `${totalBits - eosEnd} valid bit(s) remain after EOS`, eosEnd);
  }

  // 填充位检查：[totalBits, 末字节末尾) 必须全为 0，报第一个为 1 的填充位。
  const lastByteEnd = ((totalBits + 7) >> 3) << 3;
  for (let pos = totalBits; pos < lastByteEnd; pos++) {
    if (bitAt(bytes, pos) === 1) {
      fail("BAD_PADDING", `padding bit at offset ${pos} is 1`, pos);
    }
  }

  return {
    ok: true,
    symbols: spans.map((s) => s.symbol),
    spans,
    codeTable: table.map(({ symbol, length, code }) => ({ symbol, length, code })),
    totalBits,
  };
}

function decodeSpans(bytes: Uint8Array, totalBits: number, table: CodeEntry[]): Span[] {
  const byCode = new Map<string, string>(table.map((e) => [e.code, e.symbol]));
  // 所有已分配码字（含未完成前缀）：当前累积串一旦不构成任何码字前缀，
  // 立即在「出错位」报 NO_VALID_PREFIX，而非等到达到最大码长。
  const prefixes = new Set<string>();
  for (const e of table) {
    for (let len = 1; len <= e.code.length; len++) {
      prefixes.add(e.code.slice(0, len));
    }
  }
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
    } else if (!prefixes.has(code)) {
      fail("NO_VALID_PREFIX", `bit string ${code} is not a prefix of any codeword`, pos);
    } else if (code.length >= maxLength) {
      // 理论上不可达：长度达到最大值仍非某码字前缀时，上面的前缀检查
      // 已经触发。保留以覆盖任何边界情况。
      fail("NO_VALID_PREFIX", "invalid codeword", pos);
    }
  }
  // 有效位耗尽仍未遇到结束符号（最后一个码字也可能残缺）。
  fail("MISSING_EOS", "valid bits exhausted before EOS was decoded", totalBits);
}
