/** Wait only for the declared background, never for an entire video download. */
export async function waitForPlayableBackdrop(
  root: ShadowRoot,
  signal: AbortSignal,
  onDiagnostic: (message: string) => void,
): Promise<void> {
  const media = root.querySelectorAll<HTMLImageElement | HTMLVideoElement>(
    '[data-media="backdrop"] img, [data-media="backdrop"] video',
  );
  await Promise.all(
    [...media].map((element) => {
      // An empty media placeholder has nothing to load.
      if (
        !element.getAttribute("src") &&
        !element.querySelector("source[src]") &&
        !element.getAttribute("srcset")
      )
        return;
      return new Promise<void>((resolve) => {
        const view = root.ownerDocument.defaultView!;
        const image =
          element.tagName === "IMG" ? (element as HTMLImageElement) : undefined;
        const video = image ? undefined : (element as HTMLVideoElement);
        let settled = false;
        let decoding = false;
        const events = ["load", "loadeddata", "canplay", "seeked"];
        const finish = () => {
          if (settled) return;
          settled = true;
          view.clearTimeout(timer);
          for (const event of events) element.removeEventListener(event, check);
          element.removeEventListener("error", finish);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const check = () => {
          if (image?.complete && !decoding) {
            decoding = true;
            if (typeof image.decode === "function")
              void image.decode().then(finish, finish);
            else finish();
          } else if (
            video &&
            (video.error || (video.readyState >= 2 && !video.seeking))
          ) {
            finish();
          }
        };
        // A missing/broken asset must not hold navigation indefinitely.
        const timer = view.setTimeout(() => {
          finish();
          onDiagnostic(
            "The Scene background did not become ready within 5 seconds. Showing the Scene anyway.",
          );
        }, 5_000);
        for (const event of events) element.addEventListener(event, check);
        element.addEventListener("error", finish, { once: true });
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
        else check();
      });
    }),
  );
  signal.throwIfAborted();
}
