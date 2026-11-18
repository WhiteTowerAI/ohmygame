// What a plugin's panel is opened with (API 2.35.0): a `state` its page
// hears, from a command (`run.state`), a page (`host.panels.open`) or native
// code (`context.panels.open`). Each way checks it with `panelStateIssue`.

/**
 * The most a panel's `state` is, as JSON: enough to say where to go, such as
 * `{ "effect": "impacts/ricochet" }`, not to carry its content.
 */
export const PLUGIN_PANEL_STATE_MAX_CHARS = 16_000;

/** Why a panel's `state` can't be sent, or undefined when it can: JSON of at most `PLUGIN_PANEL_STATE_MAX_CHARS`. */
export function panelStateIssue(state: unknown): string | undefined {
  let json: string | undefined;
  try {
    json = JSON.stringify(state);
  } catch {
    json = undefined;
  }
  if (json === undefined) return "a panel's state is JSON";
  return json.length > PLUGIN_PANEL_STATE_MAX_CHARS
    ? `a panel's state is at most ${PLUGIN_PANEL_STATE_MAX_CHARS.toLocaleString("en")} characters of JSON`
    : undefined;
}
