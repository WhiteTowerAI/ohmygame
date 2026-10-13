import { webGamePlayerUrl } from "../shared/web-game-player.js";

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
});
