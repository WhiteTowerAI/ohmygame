// The page components' major versions, which the app serves at
// /_ohmygame/ui/<major>/ from packages/plugin-ui/ui/<major>/. A major in
// preview loads only for a plugin whose manifest opts in, and may change
// between releases; a stable one only grows.
//
// Keep this file without imports: the contract check
// (scripts/plugin-ui-contract.ts) loads the copy on the branch a change
// targets, to know which majors were stable there.

/** Every major the app serves. */
export const PLUGIN_UI_MAJORS: readonly string[] = ["1"];

/** Majors still in preview. */
export const PLUGIN_UI_PREVIEW_MAJORS: ReadonlySet<string> = new Set(["1"]);

/**
 * Stable majors a newer one has replaced, with the dates (YYYY-MM-DD) it came
 * out and until which this one is served. The contract check lets a stable
 * major go only once its date has passed.
 */
export const PLUGIN_UI_RETIRING: Readonly<Record<string, { since: string; until: string }>> = {};

/** How long a replaced major stays served, at the least. */
export const PLUGIN_UI_SUPPORT_MONTHS = 12;

/** A replaced major served for less than the support window, by its dates. */
export function pluginUiSupportIssues(retiring: typeof PLUGIN_UI_RETIRING): string[] {
  return Object.entries(retiring).flatMap(([major, { since, until }]) => {
    const earliest = new Date(`${since}T00:00:00Z`);
    earliest.setUTCMonth(earliest.getUTCMonth() + PLUGIN_UI_SUPPORT_MONTHS);
    const last = new Date(`${until}T00:00:00Z`);
    return Number.isNaN(earliest.getTime()) || Number.isNaN(last.getTime()) || last < earliest
      ? [`Components ${major} must be served for ${PLUGIN_UI_SUPPORT_MONTHS} months after ${since}, not until ${until}`]
      : [];
  });
}
