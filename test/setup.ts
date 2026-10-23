import { vi } from "vitest";

// Waits cover real processes, servers and snapshots, which can take longer than
// vitest's 1s default on a loaded Windows runner. Polling still returns as soon
// as the condition holds; an explicit limit is kept as written.
const WAIT_MS = 10_000;
type Options = number | { timeout?: number; interval?: number } | undefined;
const withDefault = (options: Options) =>
  typeof options === "number"
    ? options
    : { ...options, timeout: options?.timeout ?? WAIT_MS };

const { waitFor, waitUntil } = vi;
vi.waitFor = ((callback, options) =>
  waitFor(callback, withDefault(options))) as typeof vi.waitFor;
vi.waitUntil = ((callback, options) =>
  waitUntil(callback, withDefault(options))) as typeof vi.waitUntil;
