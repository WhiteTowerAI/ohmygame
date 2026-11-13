import { createService, cliRunner } from "./service.mjs";

// Host call cancellation must settle its waiter promptly: an uncooperative
// waiter would make the host terminate every operation in the plugin process.
// The service owns ongoing work; plugin disposal separately stops its CLI.
export function waitForOwned(work, signal) {
  if (signal?.aborted)
    return Promise.reject(new Error("TapTap call cancelled"));
  const owner = Promise.resolve().then(work);
  if (!signal) return owner;
  return new Promise((resolve, reject) => {
    const cancel = () =>
      reject(
        new Error(
          "TapTap call cancelled; ongoing upload can be checked in the panel",
        ),
      );
    signal.addEventListener("abort", cancel, { once: true });
    owner.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
}

export function activate(context) {
  if (!context.project?.folder) return;
  const lifetime = new AbortController();
  context.onDispose(() => lifetime.abort());
  const service = createService({
    workspace: context.project.folder,
    directory: context.dataFolder,
    run: cliRunner(
      context.configuration.cliPath || "taptap-cli",
      context.project.folder,
      lifetime.signal,
    ),
  });
  const handler = (name) => (input, call) =>
    waitForOwned(() => service[name](input ?? {}), call?.signal);
  context.registerTool("taptap_status", handler("status"));
  context.registerTool("taptap_reconcile_upload", handler("reconcile"));
  for (const name of [
    "discover",
    "capabilities",
    "image",
    "saveFields",
    "uploadImage",
    "bind",
    "status",
    "developers",
    "apps",
    "select",
    "overview",
    "module",
    "prepare",
    "upload",
    "reconcile",
  ])
    context.registerCommand(name, handler(name));
}
