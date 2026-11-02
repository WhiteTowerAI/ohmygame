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
