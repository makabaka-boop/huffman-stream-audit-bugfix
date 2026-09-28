import { fail } from "./errors.js";

const HEX_BYTE = /^[0-9a-fA-F]{2}$/;

/**
 * 把十六进制字节块解析成一段连续字节序列。
 * 每个块必须是偶数长度的十六进制串（大小写均可），空块等价于零字节。
 * 任何结构问题一律报 INVALID_INPUT（bitOffset 与比特流无关，记 null）。
 */
export function parseHexBlocks(blocks: unknown): Uint8Array {
  if (!Array.isArray(blocks)) {
    fail("INVALID_INPUT", "bitstream.blocks must be an array of hex strings", null);
  }
  const bytes: number[] = [];
  for (const block of blocks) {
    if (typeof block !== "string" || block.length % 2 !== 0) {
      fail(
        "INVALID_INPUT",
        "each bitstream block must be an even-length hexadecimal string",
        null,
      );
    }
    for (let i = 0; i < block.length; i += 2) {
      const pair = block.slice(i, i + 2);
      if (!HEX_BYTE.test(pair)) {
        fail("INVALID_INPUT", `invalid hexadecimal byte ${JSON.stringify(pair)}`, null);
      }
      bytes.push(Number.parseInt(pair, 16));
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * 全局位读取：比特流按 MSB-first 解释（每字节的最高位是最先传输的位），
 * pos 为跨块连续的全局位偏移——块边界在这里完全不可见，
 * 因此跨越块边界的码字可以被自然读出。
 */
export function bitAt(bytes: Uint8Array, pos: number): number {
  const byte = bytes[pos >> 3];
  if (byte === undefined) {
    fail(
      "BITSTREAM_TOO_SHORT",
      `bit offset ${pos} lies beyond the ${bytes.length * 8} transmitted bits`,
      bytes.length * 8,
    );
  }
  return (byte >> (7 - (pos & 7))) & 1;
}
