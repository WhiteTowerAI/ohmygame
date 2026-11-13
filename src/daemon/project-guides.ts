/** On-demand authoring contracts, available without changing workspace files. */
export const PROJECT_GUIDES = {
  panels: `Create .ohmygame/panels/<name>/ with a lowercase-hyphenated name. Example panel.json:
\`\`\`json
{"title":"Level stats","entry":"index.html","area":"right","capabilities":{"project.files":"read"},"net":["api.example.com"]}
\`\`\`
Only title is required; entry defaults to index.html and area to right (left, center and bottom are also supported). Request only necessary capabilities: "project.files": "read" or "write", and boolean composer, project.selection, project.history or project.usage. net lists at most 20 HTTPS host names, without schemes or paths. Unknown keys are rejected.
The page links /_ohmygame/plugin-ui.css and loads an external module script importing { connect } from "/_ohmygame/plugin-ui.js"; inline scripts are blocked. Use const host = await connect(); host.files reads and writes project files within granted permissions. host.request("net.fetch", { url, method, headers, body }) reaches listed hosts over HTTPS without cookies; redirects are returned, not followed, and the response body is text.
The person must allow the panel before it runs, and approve capability changes. Panels are refreshed after the agent turn. Read uncaught errors at .ohmygame/local/panel-errors/<name>.log.`,
  "scene-media":
    'To trim a Scene\'s background video, set data-clip-start and/or data-clip-end on its single data-media="backdrop" element with data-type="video". Times are finite, non-negative seconds in the original video; end must exceed start. Omit start for zero and end for the natural end. The story runtime enforces the range, including customized project media helpers; do not rewrite shared/style/components.js for trimming. An early clip end emits the video ended event, so existing Scene logic still controls navigation. Remove both clip attributes when replacing or removing the background. Trimming never edits the original asset and does not reduce the published video file size. Keep existing IDs, Signals and interactions; run playable_check and playtest the affected route.',
} as const;
