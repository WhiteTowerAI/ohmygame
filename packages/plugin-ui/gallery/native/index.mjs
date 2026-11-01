// Commands for the gallery's command buttons: one that reports progress for a
// few seconds, and one that fails.
const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Cancelled"));
    });
  });

export function activate(context) {
  context.registerCommand("work", async (_input, options) => {
    for (const step of ["Checking…", "Downloading…", "Finishing…"]) {
      options.progress(step);
      await pause(1200, options.signal);
    }
    return { finishedAt: new Date().toISOString() };
  });
  context.registerCommand("fail", async (_input, options) => {
    options.progress("Trying…");
    await pause(1000, options.signal);
    throw new Error("Python 3.8 or later is required. Install it, then try again.");
  });
}
