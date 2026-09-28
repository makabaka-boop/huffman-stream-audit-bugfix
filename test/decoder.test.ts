import { describe, expect, it } from "vitest";
import { decode } from "../src/decoder.js";

/** 便捷构造：完整前缀码 A=0, B=10, EOS=11 */
const COMPLETE = [
  { symbol: "A", length: 1 },
  { symbol: "B", length: 2 },
  { symbol: "EOS", length: 2 },
];

describe("规范码表重建", () => {
  it("按码长、符号 UTF-8 字节序分配码字", () => {
    // 字节序: A=0x41 < "EOS"=0x45,0x4F,0x53 < Z=0x5A < b=0x62
    const r = decode({
      symbols: [
        { symbol: "b", length: 2 },
        { symbol: "Z", length: 2 },
        { symbol: "EOS", length: 2 },
        { symbol: "A", length: 2 },
      ],
      bitstream: { blocks: ["10"], totalBits: 4 }, // A=00, EOS=01
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.codeTable).toEqual([
      { symbol: "A", length: 2, code: "00" },
      { symbol: "EOS", length: 2, code: "01" },
      { symbol: "Z", length: 2, code: "10" },
      { symbol: "b", length: 2, code: "11" },
    ]);
    expect(r.symbols).toEqual(["A", "EOS"]);
    expect(r.spans).toEqual([
      { symbol: "A", start: 0, end: 2 },
      { symbol: "EOS", start: 2, end: 4 },
    ]);
  });

  it("允许不完整但合法的码表（Kraft < 1）", () => {
    // A=0, B=10, EOS=110；111 未分配
    const r = decode({
      symbols: [
        { symbol: "A", length: 1 },
        { symbol: "B", length: 2 },
        { symbol: "EOS", length: 3 },
      ],
      bitstream: { blocks: ["98"], totalBits: 6 }, // 10 0 110 → B A EOS
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.codeTable).toEqual([
      { symbol: "A", length: 1, code: "0" },
      { symbol: "B", length: 2, code: "10" },
      { symbol: "EOS", length: 3, code: "110" },
    ]);
    expect(r.symbols).toEqual(["B", "A", "EOS"]);
    expect(r.spans).toEqual([
      { symbol: "B", start: 0, end: 2 },
      { symbol: "A", start: 2, end: 3 },
      { symbol: "EOS", start: 3, end: 6 },
    ]);
  });
});

describe("跨块连续解码", () => {
  it("码字跨越块边界时不会被误判", () => {
    // A=0, B=10, EOS=11；消息 A×7 B EOS → 0000000 10 11（11 位）
    // B 的码字 [7,9) 正好横跨两个字节块。
    const r = decode({
      symbols: COMPLETE,
      bitstream: { blocks: ["01", "60"], totalBits: 11 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.symbols).toEqual(["A", "A", "A", "A", "A", "A", "A", "B", "EOS"]);
    expect(r.spans.at(-2)).toEqual({ symbol: "B", start: 7, end: 9 });
    expect(r.spans.at(-1)).toEqual({ symbol: "EOS", start: 9, end: 11 });
  });

  it("15 位码字跨越多个单字节块", () => {
    // A=0；B=100000000000000；EOS=100000000000001（不完整码表）
    const r = decode({
      symbols: [
        { symbol: "A", length: 1 },
        { symbol: "B", length: 15 },
        { symbol: "EOS", length: 15 },
      ],
      bitstream: { blocks: ["40", "00", "80", "02"], totalBits: 31 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.symbols).toEqual(["A", "B", "EOS"]);
    expect(r.spans).toEqual([
      { symbol: "A", start: 0, end: 1 },
      { symbol: "B", start: 1, end: 16 },
      { symbol: "EOS", start: 16, end: 31 },
    ]);
  });


});

describe("整份报错与首次出错的全局位偏移", () => {
  it("超额订码 → OVERSUBSCRIBED @0", () => {
    const r = decode({
      symbols: [
        { symbol: "A", length: 1 },
        { symbol: "B", length: 1 },
        { symbol: "EOS", length: 1 },
      ],
      bitstream: { blocks: ["00"], totalBits: 3 },
    });
    expect(r).toMatchObject({ ok: false, error: { code: "OVERSUBSCRIBED", bitOffset: 0 } });
  });

  it("码表缺 EOS → MISSING_EOS @0", () => {
    const r = decode({
      symbols: [
        { symbol: "A", length: 1 },
        { symbol: "B", length: 1 },
      ],
      bitstream: { blocks: ["00"], totalBits: 2 },
    });
    expect(r).toMatchObject({ ok: false, error: { code: "MISSING_EOS", bitOffset: 0 } });
  });

  it("解码途中无任何可能前缀 → NO_VALID_PREFIX，报出错位", () => {
    // 不完整码表 A=0, B=10, EOS=110；比特 0 111…：读完第 3 位（偏移 3）后 111 无前缀可走
    const r = decode({
      symbols: [
        { symbol: "A", length: 1 },
        { symbol: "B", length: 2 },
        { symbol: "EOS", length: 3 },
      ],
      bitstream: { blocks: ["70"], totalBits: 4 }, // 0111
    });
    expect(r).toMatchObject({ ok: false, error: { code: "NO_VALID_PREFIX", bitOffset: 3 } });
  });

  it("有效位耗尽仍未见 EOS → MISSING_EOS @totalBits", () => {
    const r = decode({
      symbols: COMPLETE,
      bitstream: { blocks: ["40"], totalBits: 4 }, // 0 10 0 → A B A，没有 EOS
    });
    expect(r).toMatchObject({ ok: false, error: { code: "MISSING_EOS", bitOffset: 4 } });
  });

  it("EOS 之后仍有有效位 → EXTRA_BITS，报 EOS 结束位", () => {
    const r = decode({
      symbols: COMPLETE,
      bitstream: { blocks: ["70"], totalBits: 5 }, // 0 11 10…：EOS 在 [1,3)，后面还有 2 位
    });
    expect(r).toMatchObject({ ok: false, error: { code: "EXTRA_BITS", bitOffset: 3 } });
  });

  it("末字节填充位非零 → BAD_PADDING，报第一个为 1 的填充位", () => {
    const okCase = decode({
      symbols: COMPLETE,
      bitstream: { blocks: ["60"], totalBits: 3 }, // 011 + 全零填充
    });
    expect(okCase.ok).toBe(true);

    const atEnd = decode({
      symbols: COMPLETE,
      bitstream: { blocks: ["61"], totalBits: 3 }, // 填充位 00001
    });
    expect(atEnd).toMatchObject({ ok: false, error: { code: "BAD_PADDING", bitOffset: 7 } });

    const atStart = decode({
      symbols: COMPLETE,
      bitstream: { blocks: ["70"], totalBits: 3 }, // 填充位 10000
    });
    expect(atStart).toMatchObject({ ok: false, error: { code: "BAD_PADDING", bitOffset: 3 } });

    const inMiddle = decode({
      symbols: COMPLETE,
      bitstream: { blocks: ["68"], totalBits: 3 }, // 填充位 01000
    });
    expect(inMiddle).toMatchObject({ ok: false, error: { code: "BAD_PADDING", bitOffset: 4 } });
  });

  it("声明的有效位超过实际传输位 → BITSTREAM_TOO_SHORT", () => {
    const r = decode({
      symbols: COMPLETE,
      bitstream: { blocks: ["ff"], totalBits: 9 },
    });
    expect(r).toMatchObject({ ok: false, error: { code: "BITSTREAM_TOO_SHORT", bitOffset: 8 } });
  });

  it("空比特流 → MISSING_EOS @0", () => {
    const r = decode({ symbols: COMPLETE, bitstream: { blocks: [], totalBits: 0 } });
    expect(r).toMatchObject({ ok: false, error: { code: "MISSING_EOS", bitOffset: 0 } });
  });
});

describe("边界与容错", () => {
  it("消息可以只有 EOS 一个符号", () => {
    const r = decode({ symbols: COMPLETE, bitstream: { blocks: ["c0"], totalBits: 2 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.symbols).toEqual(["EOS"]);
    expect(r.spans).toEqual([{ symbol: "EOS", start: 0, end: 2 }]);
  });

  it("十六进制大小写均可，空块等价于零字节", () => {
    const lower = decode({ symbols: COMPLETE, bitstream: { blocks: ["c0"], totalBits: 2 } });
    const upper = decode({ symbols: COMPLETE, bitstream: { blocks: ["", "C0"], totalBits: 2 } });
    expect(lower.ok).toBe(true);
    expect(upper).toEqual(lower);
  });

  it("非法输入结构 → INVALID_INPUT", () => {
    const bad: unknown[] = [
      null,
      [],
      "x",
      {},
      { symbols: COMPLETE }, // 缺 bitstream
      { symbols: [{ symbol: "A", length: 1 }], bitstream: { blocks: [], totalBits: 0 } }, // 少于 2 个符号
      {
        symbols: Array.from({ length: 65 }, (_, i) => ({ symbol: i === 64 ? "EOS" : String.fromCharCode(0x21 + i), length: 6 })),
        bitstream: { blocks: [], totalBits: 0 },
      }, // 超过 64 个符号
      { symbols: [...COMPLETE, { symbol: "A", length: 3 }], bitstream: { blocks: [], totalBits: 0 } }, // 重复符号
      { symbols: [{ symbol: "é", length: 1 }, { symbol: "EOS", length: 1 }], bitstream: { blocks: [], totalBits: 0 } }, // 非 ASCII
      { symbols: [{ symbol: "AB", length: 1 }, { symbol: "EOS", length: 1 }], bitstream: { blocks: [], totalBits: 0 } }, // 多字符
      { symbols: [{ symbol: "", length: 1 }, { symbol: "EOS", length: 1 }], bitstream: { blocks: [], totalBits: 0 } }, // 空符号
      { symbols: [{ symbol: "A", length: 0 }, { symbol: "EOS", length: 1 }], bitstream: { blocks: [], totalBits: 0 } }, // 码长 0
      { symbols: [{ symbol: "A", length: 16 }, { symbol: "EOS", length: 1 }], bitstream: { blocks: [], totalBits: 0 } }, // 码长 16
      { symbols: [{ symbol: "A", length: 1.5 }, { symbol: "EOS", length: 1 }], bitstream: { blocks: [], totalBits: 0 } }, // 非整数
      { symbols: COMPLETE, bitstream: { blocks: "c0", totalBits: 2 } }, // blocks 不是数组
      { symbols: COMPLETE, bitstream: { blocks: ["abc"], totalBits: 2 } }, // 奇数长度
      { symbols: COMPLETE, bitstream: { blocks: ["0g"], totalBits: 2 } }, // 非法十六进制
      { symbols: COMPLETE, bitstream: { blocks: ["c0"], totalBits: -1 } },
      { symbols: COMPLETE, bitstream: { blocks: ["c0"], totalBits: 1.5 } },
      { symbols: COMPLETE, bitstream: { blocks: ["c0"], totalBits: "2" } },
    ];
    for (const input of bad) {
      const r = decode(input);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("INVALID_INPUT");
        expect(r.error.bitOffset).toBeNull();
      }
    }
  });
});

