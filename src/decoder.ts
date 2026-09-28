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
  blocks: string[];
  totalBits: number;
}

function isNonNegativeInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
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
  // 1. 输入结构校验（INVALID_INPUT，bitOffset 恒为 null）
  const spec = parseInput(input);

  // 2. 比特流结构：十六进制块解析（INVALID_INPUT）
  const bytes = parseHexBlocks(spec.blocks);
  const transmittedBits = bytes.length * 8;

  // 3. 码表重建：超额订码检测（OVERSUBSCRIBED @0），随后要求 EOS 恰好一次（MISSING_EOS @0）
  const table = buildCodeTable(spec.symbols);
  if (!table.some((e) => e.symbol === EOS)) {
    fail("MISSING_EOS", "code table does not contain the required EOS symbol", 0);
  }

  // 4. 声明有效位超过实际传输位（BITSTREAM_TOO_SHORT @实际可用位数）
  if (spec.totalBits > transmittedBits) {
    fail(
      "BITSTREAM_TOO_SHORT",
      `declared ${spec.totalBits} valid bits but only ${transmittedBits} bits were transmitted`,
      transmittedBits,
    );
  }

  // 5. 连续解码直到 EOS
  const spans = decodeSpans(bytes, spec.totalBits, table);

  // 6. EOS 之后仍有有效位（EXTRA_BITS @EOS 结束位）
  const eosEnd = spans[spans.length - 1]!.end;
  if (eosEnd < spec.totalBits) {
    fail(
      "EXTRA_BITS",
      `EOS ended at bit ${eosEnd} but ${spec.totalBits - eosEnd} valid bit(s) follow`,
      eosEnd,
    );
  }

  // 7. 末字节填充位必须全为 0（BAD_PADDING @第一个为 1 的填充位）
  checkPadding(bytes, spec.totalBits, transmittedBits);

  return {
    ok: true,
    symbols: spans.map((s) => s.symbol),
    spans,
    codeTable: table.map(({ symbol, length, code }) => ({ symbol, length, code })),
    totalBits: spec.totalBits,
  };
}

function parseInput(input: unknown): ParsedInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_INPUT", "input must be a JSON object", null);
  }
  const root = input as Record<string, unknown>;

  const rawSymbols = root.symbols;
  if (!Array.isArray(rawSymbols)) {
    fail("INVALID_INPUT", "input.symbols must be an array", null);
  }
  if (rawSymbols.length < MIN_SYMBOLS || rawSymbols.length > MAX_SYMBOLS) {
    fail(
      "INVALID_INPUT",
      `expected between ${MIN_SYMBOLS} and ${MAX_SYMBOLS} symbols, got ${rawSymbols.length}`,
      null,
    );
  }

  const symbols: SymbolLength[] = [];
  const seen = new Set<string>();
  for (const entry of rawSymbols) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      fail("INVALID_INPUT", "each symbol entry must be an object { symbol, length }", null);
    }
    const record = entry as Record<string, unknown>;
    const { symbol, length } = record;
    if (!isValidSymbolName(symbol)) {
      fail(
        "INVALID_INPUT",
        `invalid symbol name ${JSON.stringify(symbol)}: expected a single ASCII character (U+0000..U+007F) or "EOS"`,
        null,
      );
    }
    if (seen.has(symbol)) {
      fail("INVALID_INPUT", `duplicate symbol ${JSON.stringify(symbol)} in length table`, null);
    }
    seen.add(symbol);

    if (typeof length !== "number" || !Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
      fail(
        "INVALID_INPUT",
        `invalid code length ${JSON.stringify(length)} for symbol ${JSON.stringify(symbol)}: expected an integer in [${MIN_LENGTH}, ${MAX_LENGTH}]`,
        null,
      );
    }
    symbols.push({ symbol, length });
  }
  // 注意：EOS「缺失」不在此处判 INVALID_INPUT——它属于码表流水线错误 MISSING_EOS @0；
  // EOS「重复出现」已由上面的符号唯一性检查拒绝（INVALID_INPUT）。

  const bitstream = root.bitstream;
  if (bitstream === null || typeof bitstream !== "object" || Array.isArray(bitstream)) {
    fail("INVALID_INPUT", "input.bitstream must be an object { blocks, totalBits }", null);
  }
  const stream = bitstream as Record<string, unknown>;
  if (!Array.isArray(stream.blocks)) {
    fail("INVALID_INPUT", "bitstream.blocks must be an array of hex strings", null);
  }
  if (!isNonNegativeInteger(stream.totalBits)) {
    fail(
      "INVALID_INPUT",
      `bitstream.totalBits must be a non-negative safe integer, got ${JSON.stringify(stream.totalBits)}`,
      null,
    );
  }

  return { symbols, blocks: stream.blocks as string[], totalBits: stream.totalBits };
}

/**
 * 从位 0 起连续解码（跨块、跨字节）。
 * 用全部码字的真前缀集合判断：读到某位后，当前串既不是某个码字、也不再是任何码字的
 * 前缀，则该位就是 NO_VALID_PREFIX 的首次出错位——不必等到读满最大码长。
 * 有效位耗尽仍未完成任何码字（也未遇 EOS）→ MISSING_EOS @totalBits。
 */
function decodeSpans(bytes: Uint8Array, totalBits: number, table: CodeEntry[]): Span[] {
  const codewords = new Map<string, string>();
  const prefixes = new Set<string>();
  for (const e of table) {
    codewords.set(e.code, e.symbol);
    for (let k = 1; k < e.code.length; k++) {
      prefixes.add(e.code.slice(0, k));
    }
  }

  const spans: Span[] = [];
  let start = 0;
  let code = "";
  for (let pos = 0; pos < totalBits; pos++) {
    code += bitAt(bytes, pos);
    const symbol = codewords.get(code);
    if (symbol !== undefined) {
      spans.push({ symbol, start, end: pos + 1 });
      if (symbol === EOS) return spans;
      start = pos + 1;
      code = "";
    } else if (!prefixes.has(code)) {
      fail(
        "NO_VALID_PREFIX",
        `bit prefix ${code} at global bit offset ${pos} does not start any codeword`,
        pos,
      );
    }
  }

  // 走到这里说明循环中从未在「无任何可能前缀」的位置失败：
  // 无论末尾是否还挂着一个仍可能续成码字的前缀，都属于有效位耗尽仍未见 EOS。
  fail("MISSING_EOS", `valid bits exhausted at bit ${totalBits} without encountering EOS`, totalBits);
}

/** 末字节中 [totalBits, transmittedBits) 的填充位必须全部为 0。 */
function checkPadding(bytes: Uint8Array, totalBits: number, transmittedBits: number): void {
  for (let pos = totalBits; pos < transmittedBits; pos++) {
    if (bitAt(bytes, pos) === 1) {
      fail("BAD_PADDING", `padding bit at global bit offset ${pos} is 1; all padding bits must be 0`, pos);
    }
  }
}
