import { showBackdrop } from "../../shared/style/components.js";
import { layoutStory } from "./layout.js";

/**
 * Scenes that are not steps in the story, such as menus and settings, by ID.
 * The map leaves them out and joins the Scenes on either side.
 */
const OFF_MAP = new Set(["main-menu", "story-map"]);
/** Names players see on the map instead of a Scene's title, by Scene ID. */
const LABELS = {};
/** Whether a Scene counts as an ending: by default, when no Exit moves the story on from it. */
const isEnding = (node) => !node.signals.some((signal) => signal.role !== "navigation");
/** Show every Scene, locked or not, instead of only those one step past what the player has seen. */
const SHOW_ALL = false;
/** Sizes in cqw (hundredths of the screen width): a card, the space it takes in a row, and a row. */
const CARD_WIDTH = 12;
const CARD_HEIGHT = 3.6;
const COLUMN = 14.5;
const ROW = 5.6;

export async function mount(context) {
  const backdrop = showBackdrop(context);
  const map = context.root.querySelector("[data-map]");
  const scroll = context.root.querySelector(".story-map-scroll");
  const progress = context.root.querySelector("[data-progress]");
  const back = context.root.querySelector("[data-back]");
  // The story's flow is graph.json; what the player has seen comes from the Runtime.
  const graph = await (await fetch(new URL("graph.json", document.baseURI))).json();
  const record = context.story.seen();
  const layout = layoutStory(graph, { offMap: OFF_MAP, labels: LABELS, isEnding });
  const nodes = layout.nodes.map((node) => ({ ...node, seen: Object.hasOwn(record.nodes, node.id) }));
  const edges = layout.links.map((link) => ({
    from: link.from,
    to: link.to,
    seen: Object.hasOwn(record.edges, link.via) && Object.hasOwn(record.nodes, link.to),
  }));

  // The Scenes seen, and the locked ones a step past them; the first ones before anything is seen.
  const seen = new Set(nodes.filter((node) => node.seen).map((node) => node.id));
  const shown = new Set(SHOW_ALL ? nodes.map((node) => node.id) : [
    ...seen,
    ...edges.filter((edge) => seen.has(edge.from)).map((edge) => edge.to),
    ...(seen.size ? [] : nodes.filter((node) => node.row === 0).map((node) => node.id)),
  ]);
  const visible = nodes.filter((node) => shown.has(node.id));
  const endings = nodes.filter((node) => node.ending);
  progress.textContent = `Scenes ${seen.size}/${nodes.length} · Endings ${endings.filter((node) => node.seen).length}/${endings.length}`;

  // Rows with nothing shown close up. Each row is centred under the widest.
  const rows = [...new Set(visible.map((node) => node.row))].sort((a, b) => a - b);
  const width = Math.max(1, ...visible.map((node) => node.rowSize)) * COLUMN;
  const height = rows.length * ROW;
  const place = new Map(visible.map((node) => [node.id, {
    x: width / 2 + (node.column - (node.rowSize - 1) / 2) * COLUMN,
    y: rows.indexOf(node.row) * ROW + ROW / 2,
  }]));
  map.style.width = `${width}cqw`;
  map.style.height = `${height}cqw`;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-hidden", "true");
  for (const edge of edges) {
    const from = place.get(edge.from);
    const to = place.get(edge.to);
    if (!from || !to) continue;
    const top = from.y + CARD_HEIGHT / 2;
    const bottom = to.y - CARD_HEIGHT / 2;
    const bend = (bottom - top) / 2;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${from.x} ${top} C ${from.x} ${top + bend}, ${to.x} ${bottom - bend}, ${to.x} ${bottom}`);
    if (edge.seen) path.classList.add("is-seen");
    svg.append(path);
  }
  map.append(svg);

  let last;
  for (const node of visible) {
    const { x, y } = place.get(node.id);
    const card = document.createElement("div");
    card.className = "story-map-node";
    card.classList.toggle("is-locked", !node.seen);
    card.classList.toggle("is-ending", node.ending);
    card.style.left = `${x - CARD_WIDTH / 2}cqw`;
    card.style.top = `${y - CARD_HEIGHT / 2}cqw`;
    card.textContent = node.seen ? node.label : "???";
    if (node.ending) {
      const tag = document.createElement("small");
      tag.textContent = "Ending";
      card.append(tag);
    }
    map.append(card);
    if (node.seen && (!last || node.row > last.row)) last = { row: node.row, card };
  }
  // Open where the player has got to: the lowest Scene seen, in the middle.
  if (last) scroll.scrollTop += last.card.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientHeight / 2;

  // A mouse can drag the map up and down as well as scroll it.
  let drag;
  const onDown = (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    drag = { y: event.clientY, top: scroll.scrollTop };
    scroll.setPointerCapture(event.pointerId);
    scroll.classList.add("is-dragging");
  };
  const onMove = (event) => {
    if (drag) scroll.scrollTop = drag.top - (event.clientY - drag.y);
  };
  const onUp = () => {
    drag = undefined;
    scroll.classList.remove("is-dragging");
  };
  scroll.addEventListener("pointerdown", onDown);
  scroll.addEventListener("pointermove", onMove);
  scroll.addEventListener("pointerup", onUp);
  scroll.addEventListener("pointercancel", onUp);

  // Back returns to the Scene that opened the map, through an Exit with Allow Back.
  const leave = () => context.navigation.back().catch(() => {});
  const onKey = (event) => {
    if (event.key === "Escape") leave();
  };
  back.addEventListener("click", leave);
  window.addEventListener("keydown", onKey);
  return () => {
    backdrop.cleanup();
    back.removeEventListener("click", leave);
    scroll.removeEventListener("pointerdown", onDown);
    scroll.removeEventListener("pointermove", onMove);
    scroll.removeEventListener("pointerup", onUp);
    scroll.removeEventListener("pointercancel", onUp);
    window.removeEventListener("keydown", onKey);
  };
}
