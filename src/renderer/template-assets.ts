/**
 * Template covers stay bundled under `assets/templates/` so the home page and
 * template pickers show them offline. Example images live on the asset CDN.
 */
const BUNDLED_TEMPLATE_ASSETS = import.meta.glob<string>(
  "./assets/templates/**/*.{webp,png,gif}",
  {
    eager: true,
    query: "?url",
    import: "default",
  },
);

const BUNDLED_PREFIX = "./assets/templates/";

/** Origin and prefix of the `template-examples/` directory in the asset bucket. */
export const TEMPLATE_EXAMPLES_URL =
  "https://assets.ohmygame.ai/template-examples";

/** URL of a bundled template cover, by its path under `assets/templates/`, such as `blank.webp`. */
export function templateAssetUrl(path: string): string {
  const url = BUNDLED_TEMPLATE_ASSETS[`${BUNDLED_PREFIX}${path}`];
  if (url === undefined) throw new Error(`Unknown template asset: ${path}`);
  return url;
}

/** URL of a template example image, by its path under `template-examples/`, such as `pixel/classic/idle.webp`. */
export function templateExampleUrl(path: string): string {
  return `${TEMPLATE_EXAMPLES_URL}/${path}`;
}
