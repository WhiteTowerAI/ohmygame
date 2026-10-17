# UI languages

The renderer ships in English and Simplified Chinese. English is the source
language; every message lives in `src/renderer/locales/en.ts`, and
`src/renderer/locales/zh-CN.ts` must have exactly the same keys. Typecheck
fails when a key is missing, and `test/i18n.test.ts` also checks that both
languages use the same `{{placeholders}}`.

## How it works

`src/renderer/i18n.ts` wraps [i18next](https://www.i18next.com/). It resolves
the language once, when the page loads: the choice in **Settings → Appearance
→ Language**, or the first system language (any `zh*` locale uses Simplified
Chinese). Changing the setting reloads the window, so module-level labels can
call `t` directly. The module also sets `<html lang>` and exports `language`
for `Intl` and `toLocale*` formatting.

- Use `t("area.key", { value })` for text. Plurals use i18next's `_one` and
  `_other` suffixes; Chinese repeats the same text for both.
- Use `tNodes("area.key", { name: <strong>…</strong> })` when a placeholder
  is a React element.
- Group keys by screen or component, and reuse `common.*` for generic actions
  such as Cancel, Save, and Retry.

## What stays in English

- Text sent to the agent: prompt context `text`, repair requests, and other
  instructions. Translate only what people see, such as a context chip's
  `label`.
- Daemon and provider error details. The renderer shows them as received,
  under a translated title when there is one.
- The Electron menus and main-process dialogs, the published game player,
  and the web game host page.
- Content from outside the app: examples, plugin and skill descriptions,
  Community games, provider and model names.

Provider authentication translates standard `Sign in with …` and `… API key`
method labels and the SDK's matching `Enter … API key` prompt in the renderer.
Brand names stay intact. Other provider instructions, including multi-step
cloud credential setup, are displayed as received so their meaning is preserved.

## Terminology

Keep Agent, MCP, Skills, Pi, API, and Base URL in English. Use 画布 for
Canvas, 素材库 for Library, 素材画布 for Asset Canvas, 场景 for Scene,
故事地图 for Story map, 服务商 for provider, and 试玩 for play or playtest.
