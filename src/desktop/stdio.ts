/**
 * Packaged Windows builds have no console, so writes to stdout or stderr can fail with EPIPE.
 * Without an `error` listener that failure is an uncaught exception that ends the main process.
 */
export function ignoreBrokenStdio(streams: NodeJS.EventEmitter[] = [process.stdout, process.stderr]): void {
  for (const stream of streams) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
  }
}
