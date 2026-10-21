import { describe, expect, test } from "vitest";
import { normalize_text } from "../src/normalize.js";

describe("normalize_text", () => {
  test("normalize covers fullwidth case and whitespace", () => {
    expect(normalize_text("ＦＵＬＬ－ｗｉｄｔｈ")).toBe("full-width");
    expect(normalize_text("Hello\tWORLD\n  Foo")).toBe("hello world foo");
    expect(normalize_text("　全角空格　分隔　")).toBe("全角空格 分隔");
    expect(normalize_text("a\u00a0b")).toBe("a b");
  });

  test("normalize keeps chinese characters unchanged", () => {
    expect(normalize_text("雨夜视觉风格")).toBe("雨夜视觉风格");
    expect(normalize_text("低照度、冷色反光")).toBe("低照度、冷色反光");
    expect(normalize_text("全角：１２３")).toBe("全角:123");
  });

  test("normalize is idempotent", () => {
    const samples = [
      "  Mixed　CASE\ttext\nwith   spaces  ",
      "ＦＵＬＬ－ｗｉｄｔｈ　１２３：ＡＢＣ",
      "雨夜  视觉\n风格\t标签",
      "",
      "   ",
    ];
    for (const sample of samples) {
      const once = normalize_text(sample);
      expect(normalize_text(once), `二次归一化必须稳定："${sample}"`).toBe(once);
      expect(once, `结果不得含首尾空白："${sample}"`).toBe(once.trim());
      expect(once, `结果不得含连续空白："${sample}"`).not.toMatch(/\s{2,}/u);
    }
  });
});
