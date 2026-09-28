import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { decode } from "../src/decoder.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const runner = fileURLToPath(new URL("../node_modules/vite-node/vite-node.mjs", import.meta.url));

/** 便捷构造：完整前缀码 A=0, B=10, EOS=11 */
const COMPLETE = [
  { symbol: "A", length: 1 },
  { symbol: "B", length: 2 },
  { symbol: "EOS", length: 2 },
];

const incomplete = () => [
  { symbol: "A", length: 1 },
  { symbol: "B", length: 2 },
  { symbol: "EOS", length: 3 },
];

async function runCli(input: string): Promise<{ stdout: string; code: number }> {
  // vite-node 运行器在子进程管道 stdin 下行为异常，改用临时文件 + shell 重定向。
  const file = join(tmpDir, `in-${counter++}.json`);
  writeFileSync(file, input);
  const cmd = `"${process.execPath}" "${runner}" "${cliPath}" < "${file}"`;
  try {
    const { stdout } = await execFileAsync("sh", ["-c", cmd], { timeout: 20000 });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    return { stdout: e.stdout ?? "", code: e.code ?? -1 };
  }
}

const tmpDir = mkdtempSync(join(tmpdir(), "huff-cli-"));
let counter = 0;

describe("回归：码表顺序与排序", () => {
  it("同一组符号长度打乱输入顺序，规范码表完全一致", () => {
    const a = [
      { symbol: "b", length: 2 },
      { symbol: "Z", length: 2 },
      { symbol: "EOS", length: 2 },
      { symbol: "A", length: 2 },
    ];
    const b = [
      { symbol: "EOS", length: 2 },
      { symbol: "A", length: 2 },
      { symbol: "b", length: 2 },
      { symbol: "Z", length: 2 },
    ];
    const ra = decode({ symbols: a, bitstream: { blocks: ["40"], totalBits: 2 } }); // 位序 0,1 = "01" = A EOS
    const rb = decode({ symbols: b, bitstream: { blocks: ["40"], totalBits: 2 } });
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    if (!ra.ok || !rb.ok) return;
    expect(rb.codeTable).toEqual(ra.codeTable);
    expect(ra.codeTable.map((e) => e.symbol)).toEqual(["A", "EOS", "Z", "b"]);
  });
});

describe("回归：无有效前缀的最早出错位", () => {
  it("不完整码表中前缀提前死亡时立即报错，不等到最大码长", () => {
    // A=0, B=10, EOS=110；位串 0 111…：读完偏移 3 的位后 "111" 已不可能是任何码字前缀。
    const r = decode({ symbols: incomplete(), bitstream: { blocks: ["70"], totalBits: 4 } });
    expect(r).toMatchObject({ ok: false, error: { code: "NO_VALID_PREFIX", bitOffset: 3 } });
  });

  it("即使存在更长码字，死前缀也按最早位报告", () => {
    // A=0, EOS=100；0xa0 位序 1,0,1,…：偏移0 "1"、偏移1 "10" 仍是前缀，偏移2 "101" 死亡。
    const r = decode({
      symbols: [
        { symbol: "A", length: 1 },
        { symbol: "EOS", length: 3 },
      ],
      bitstream: { blocks: ["a0"], totalBits: 3 },
    });
    expect(r).toMatchObject({ ok: false, error: { code: "NO_VALID_PREFIX", bitOffset: 2 } });
  });
});

describe("回归：结束符号与填充", () => {
  it("残缺码字耗尽有效位 → MISSING_EOS @totalBits", () => {
    const r = decode({ symbols: COMPLETE, bitstream: { blocks: ["40"], totalBits: 2 } }); // 位序 0,1：先解出 A，残留前缀 "1" 残缺
    expect(r).toMatchObject({ ok: false, error: { code: "MISSING_EOS", bitOffset: 2 } });
  });

  it("EXTRA_BITS 优先于 BAD_PADDING", () => {
    // 0x67 位序 0,1,1,0,0,…：0=A、11=EOS 在 [1,3)，有效 5 位（后 2 位多余）；
    // 低 3 位填充全为 1（偏移 5..7），但解码类错误优先 → EXTRA_BITS@3。
    const r = decode({ symbols: COMPLETE, bitstream: { blocks: ["67"], totalBits: 5 } });
    expect(r).toMatchObject({ ok: false, error: { code: "EXTRA_BITS", bitOffset: 3 } });
  });

  it("跨字节的填充位非零 → BAD_PADDING 报首个为 1 的填充位", () => {
    // 9 位消息 AAAAA B EOS = 00000 10 11；byte0=0x05，byte1 有效位只有 bit8。
    const okCase = decode({ symbols: COMPLETE, bitstream: { blocks: ["05", "80"], totalBits: 9 } });
    expect(okCase.ok).toBe(true);
    const bad = decode({ symbols: COMPLETE, bitstream: { blocks: ["05", "c0"], totalBits: 9 } });
    expect(bad).toMatchObject({ ok: false, error: { code: "BAD_PADDING", bitOffset: 9 } });
  });

  it("有效位恰好字节边界（无填充位）成功", () => {
    // 8 位消息 AAAA B EOS = 0000 10 11 = 0x0b
    const r = decode({ symbols: COMPLETE, bitstream: { blocks: ["0b"], totalBits: 8 } });
    expect(r.ok).toBe(true);
  });
});

describe("回归：结构校验不抛未封装异常", () => {
  it("重复 EOS（重复符号）→ INVALID_INPUT", () => {
    const r = decode({
      symbols: [
        { symbol: "EOS", length: 1 },
        { symbol: "EOS", length: 2 },
        { symbol: "A", length: 1 },
      ],
      bitstream: { blocks: [""], totalBits: 0 },
    });
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", bitOffset: null } });
  });

  it("块元素为数字 / null → INVALID_INPUT", () => {
    for (const blocks of [[12], [null], [true], [{}]]) {
      const r = decode({ symbols: COMPLETE, bitstream: { blocks, totalBits: 0 } });
      expect(r).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", bitOffset: null } });
    }
  });

  it("码长为布尔值 / NaN / Infinity → INVALID_INPUT", () => {
    for (const length of [true, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = decode({
        symbols: [
          { symbol: "A", length },
          { symbol: "EOS", length: 1 },
        ],
        bitstream: { blocks: [""], totalBits: 0 },
      });
      expect(r).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", bitOffset: null } });
    }
  });

  it("任何非法输入都返回结构化结果而非抛异常", () => {
    const hostile: unknown[] = [
      undefined,
      { symbols: null, bitstream: {} },
      { symbols: [null, { symbol: "EOS", length: 1 }], bitstream: { blocks: [], totalBits: 0 } },
      { symbols: [{ symbol: "EOS", length: 1 }], bitstream: { blocks: [], totalBits: 0 } },
      { symbols: COMPLETE, bitstream: { blocks: {}, totalBits: 0 } },
      { symbols: COMPLETE, bitstream: { blocks: ["ab"], totalBits: null } },
    ];
    for (const input of hostile) {
      expect(() => decode(input)).not.toThrow();
      const r = decode(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
  });
});

describe("回归：CLI 退出码", () => {
  it("成功输出退出码 0", async () => {
    const { stdout, code } = await runCli(JSON.stringify({
      symbols: COMPLETE,
      bitstream: { blocks: ["c0"], totalBits: 2 },
    }));
    expect(code).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
  });

  it("失败输出退出码 1 且输出整份报错", async () => {
    const { stdout, code } = await runCli(JSON.stringify({
      symbols: COMPLETE,
      bitstream: { blocks: ["61"], totalBits: 3 },
    }));
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("BAD_PADDING");
  });

  it("stdin 不是合法 JSON → INVALID_INPUT，退出码 1", async () => {
    const { stdout, code } = await runCli("{ not json");
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", bitOffset: null } });
  });
});
