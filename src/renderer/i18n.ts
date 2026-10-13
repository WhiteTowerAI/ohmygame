import i18next, { type ParseKeys } from "i18next";
import { createElement, Fragment, type ReactNode } from "react";
import en from "./locales/en.js";
import zhCN from "./locales/zh-CN.js";

export type LanguagePreference = "system" | UiLanguage;
export type UiLanguage = "en" | "zh-CN";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}

const LANGUAGE_STORAGE_KEY = "ohmygame:language";

export function readLanguagePreference(): LanguagePreference {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return stored === "en" || stored === "zh-CN" ? stored : "system";
  } catch {
    return "system";
  }
}

/** Saves the preference and reloads, so every screen renders in the new language. */
export function setLanguagePreference(preference: LanguagePreference): void {
  try {
    if (preference === "system") localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    else localStorage.setItem(LANGUAGE_STORAGE_KEY, preference);
  } catch {
    return;
  }
  window.location.reload();
}

export function resolveLanguage(
  preference: LanguagePreference,
  systemLanguages: readonly string[],
): UiLanguage {
  if (preference !== "system") return preference;
  const first = systemLanguages[0]?.toLowerCase() ?? "";
  return first === "zh" || first.startsWith("zh-") ? "zh-CN" : "en";
}

function systemLanguages(): readonly string[] {
  return typeof navigator === "undefined"
    ? []
    : (navigator.languages ?? [navigator.language]);
}

/** Fixed for the page lifetime; module-level labels may call `t` at import time. */
export const language = resolveLanguage(
  readLanguagePreference(),
  systemLanguages(),
);

void i18next.init({
  lng: language,
  fallbackLng: "en",
  resources: { en: { translation: en }, "zh-CN": { translation: zhCN } },
  interpolation: { escapeValue: false },
  initAsync: false,
});

// English sentences sometimes reuse a capitalized label mid-sentence, such as "Add {{slot, lowercase}}".
i18next.services.formatter?.add("lowercase", (value: unknown) =>
  String(value).toLowerCase(),
);

if (typeof document !== "undefined") document.documentElement.lang = language;

export const t = i18next.t;

/** Translates a message whose `{{placeholders}}` are React nodes, such as a bold project name. */
export function tNodes(
  key: ParseKeys,
  nodes: Record<string, ReactNode>,
): ReactNode {
  const message = String(
    i18next.getResource(language, "translation", key) ??
      i18next.getResource("en", "translation", key) ??
      key,
  );
  return createElement(
    Fragment,
    null,
    ...message
      .split(/\{\{(\w+)\}\}/)
      .map((part, index) => (index % 2 ? nodes[part] : part)),
  );
}
