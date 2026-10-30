// happy-dom keeps these browser functions off the test global, and Vitest only
// spies on functions that exist. Inert defaults let a test spy on what it uses.
if (typeof document !== "undefined") {
  const browser = globalThis as unknown as Record<string, unknown>;
  for (const name of ["alert", "confirm", "prompt", "open", "close"]) {
    if (typeof browser[name] !== "function") browser[name] = () => undefined;
  }
  const objectUrls = URL as unknown as Record<string, unknown>;
  if (typeof objectUrls.createObjectURL !== "function") objectUrls.createObjectURL = () => "blob:test";
  if (typeof objectUrls.revokeObjectURL !== "function") objectUrls.revokeObjectURL = () => undefined;
}
