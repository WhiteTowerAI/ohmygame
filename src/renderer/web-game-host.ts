import { colorMatrixValues, isPreviewColorFilter } from "../shared/preview-filter.js";
import { webGamePlayerUrl } from "../shared/web-game-player.js";

const SVG = "http://www.w3.org/2000/svg";
/** The filter over the game, drawn on the frame so it covers every page the game loads. */
const filterStyle = document.head.appendChild(document.createElement("style"));

// No preload, editor code, or daemon credentials enter this WebContents.
// Keeping the editor's top-level site also preserves existing iframe saves.
let frame = document.querySelector("iframe")!;
Object.assign(window, {
  loadGame: (value: string) => new Promise<void>((resolve, reject) => {
    const url = webGamePlayerUrl(value, value);
    const timeout = setTimeout(() => reject(new Error("Game page did not load.")), 15_000);
    // Replacing the frame makes Refresh reload even at a URL with a fragment.
    // Window transfers never call loadGame, so they retain this exact document.
    const next = frame.cloneNode(false) as HTMLIFrameElement;
    next.onload = () => { clearTimeout(timeout); resolve(); };
    next.src = url;
    frame.replaceWith(next);
    frame = next;
  }),
  setFilter: (filter: unknown) => {
    document.getElementById("ohmygame-filter")?.closest("svg")?.remove();
    filterStyle.textContent = "";
    if (!isPreviewColorFilter(filter)) return;
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("style", "position:absolute;width:0;height:0");
    const definition = svg.appendChild(document.createElementNS(SVG, "filter"));
    definition.id = "ohmygame-filter";
    definition.setAttribute("color-interpolation-filters", filter.colorSpace);
    const matrix = definition.appendChild(document.createElementNS(SVG, "feColorMatrix"));
    matrix.setAttribute("type", "matrix");
    matrix.setAttribute("values", colorMatrixValues(filter));
    document.body.append(svg);
    filterStyle.textContent = "iframe{filter:url(#ohmygame-filter)}";
  },
});
