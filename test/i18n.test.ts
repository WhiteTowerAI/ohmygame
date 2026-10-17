import { describe, expect, it } from "vitest";
import { resolveLanguage, t } from "../src/renderer/i18n.js";
import en from "../src/renderer/locales/en.js";
import zhCN from "../src/renderer/locales/zh-CN.js";

type Messages = { [key: string]: string | Messages };

function flatten(messages: Messages, prefix = ""): Map<string, string> {
  return new Map(
    Object.entries(messages).flatMap(([key, value]) =>
      typeof value === "string"
        ? [[`${prefix}${key}`, value] as const]
        : [...flatten(value, `${prefix}${key}.`)],
    ),
  );
}

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{\{\s*(\w+)/g)]
    .map((match) => match[1]!)
    .sort();
}

describe("UI translations", () => {
  const english = flatten(en);
  const chinese = flatten(zhCN);

  it("translates every English message into Simplified Chinese", () => {
    expect([...chinese.keys()].sort()).toEqual([...english.keys()].sort());
    expect([...chinese].filter(([, message]) => !message.trim())).toEqual([]);
  });

  it("keeps the same placeholders in both languages", () => {
    const mismatched = [...english].filter(
      ([key, message]) =>
        placeholders(message).join() !==
        placeholders(chinese.get(key) ?? "").join(),
    );
    expect(mismatched).toEqual([]);
  });
});

describe("resolveLanguage", () => {
  it("follows the first system language until the person chooses one", () => {
    expect(resolveLanguage("system", ["zh-CN", "en-US"])).toBe("zh-CN");
    expect(resolveLanguage("system", ["zh-Hant-TW"])).toBe("zh-CN");
    expect(resolveLanguage("system", ["en-US", "zh-CN"])).toBe("en");
    expect(resolveLanguage("system", [])).toBe("en");
    expect(resolveLanguage("en", ["zh-CN"])).toBe("en");
    expect(resolveLanguage("zh-CN", ["en-US"])).toBe("zh-CN");
  });
});

describe("t", () => {
  it("lowercases a label reused mid-sentence in English", () => {
    expect(t("assetCanvas.addSlot", { slot: "First frame" })).toBe(
      "Add first frame",
    );
  });
});
