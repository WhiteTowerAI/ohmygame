// OhMyGame's game_use for a Maker game. Maker's live preview can't capture
// its window, so each capture runs the game again with `preview validate`
// and keeps the frame asked for. A session is only OhMyGame's handle on the
// game: opening one starts nothing, and the person's preview is left alone.
import { randomUUID } from "node:crypto";
import { copyFile, lstat } from "node:fs/promises";
import { binding } from "./maker.mjs";
import { installed, maker, redact } from "./runtime.mjs";

/** Open sessions: the project each is for and the size it runs at, if one was asked for. */
const sessions = new Map();
/** One run at a time in a project; Maker validates one game at a time anyway. */
const queues = new Map();

export async function gameUse(context, input) {
  const { directory, workspace } = context;
  switch (input?.operation) {
    case "open": {
      await ready(directory, workspace);
      const session = randomUUID();
      sessions.set(session, { workspace, viewport: input.viewport });
      return { session, ...(input.viewport ? { viewport: input.viewport } : {}) };
    }
    case "close":
      sessions.delete(input.session);
      return {};
    case "captureFrame": {
      const session = sessions.get(input.session);
      if (!session || session.workspace !== workspace)
        throw new Error("This game session isn't open");
      return serial(workspace, () => captureFrame(context, session, input));
    }
    default:
      throw new Error(`TapTap Maker can't ${input?.operation} a game here`);
  }
}

async function ready(directory, workspace) {
  if (!(await installed(directory)))
    throw new Error("Prepare TapTap Maker first");
  if (!(await binding(workspace)))
    throw new Error("Connect a Maker project before playing it");
}

function serial(workspace, task) {
  const run = (queues.get(workspace) ?? Promise.resolve()).then(task, task);
  const settled = run.catch(() => {});
  queues.set(workspace, settled);
  void settled.then(() => {
    if (queues.get(workspace) === settled) queues.delete(workspace);
  });
  return run;
}

/** A `preview validate` result, which Maker prints even when the run failed. */
const isValidation = (value) =>
  value && typeof value === "object" && typeof value.result === "string";

async function captureFrame(
  { directory, workspace, signal },
  session,
  { output, frame },
) {
  await ready(directory, workspace);
  // Maker won't validate beside a running preview, and only the person decides to stop theirs.
  const status = await maker(
    directory,
    ["preview", "status", "--target-dir", workspace, "--json"],
    { report: true, signal },
  );
  if (status?.process_alive)
    throw new Error(
      "The Maker preview is running, and a capture runs the game again by itself. Ask the person to stop the preview, then try again; stop it with maker_preview only once they agree.",
    );
  const result = await maker(
    directory,
    [
      "preview",
      "validate",
      "--target-dir",
      workspace,
      "--mode",
      "screenshot",
      "--screenshot-frame",
      String(frame),
      // 30,000 frames at 60 FPS plus a minute. Maker adds a 20-second
      // shutdown allowance; leave room in the host's 10-minute budget.
      "--validate-timeout",
      "560",
      ...(session.viewport
        ? ["--width", String(session.viewport.width), "--height", String(session.viewport.height)]
        : []),
      "--json",
    ],
    { accept: isValidation, signal },
  );
  const error = result?.error
    ? redact(String(result.error)).slice(0, 1500)
    : "";
  const shot = Array.isArray(result?.artifacts)
    ? result.artifacts.find(
        (item) => item?.kind === "screenshot" && typeof item.path === "string",
      )
    : undefined;
  if (!shot) {
    const diagnostics = [
      ["Runtime log", result?.log_path],
      ["Invocation", result?.invocation_path],
    ]
      .filter(([, value]) => typeof value === "string" && value)
      .map(([label, value]) => `${label}: ${redact(value).slice(0, 1500)}`);
    throw new Error([error || `Maker didn't capture frame ${frame}`, ...diagnostics].join("\n"));
  }
  if (!(await lstat(shot.path)).isFile())
    throw new Error("Maker's capture isn't a file");
  await copyFile(shot.path, output);
  // When the frame was still loading, Maker tries later frames by itself; the last one is kept.
  const captured = Number.isSafeInteger(shot.frame) ? shot.frame : frame;
  const assessment = result.screenshot_assessment;
  const notes =
    assessment?.status === "NOT_READY"
      ? `Maker judged frame ${captured} not ready${Array.isArray(assessment.reasons) && assessment.reasons.length ? ` (${assessment.reasons.slice(0, 5).join(", ")})` : ""}: the game may still be loading or the screen blank. Try a later frame.`
      : result.ok === false && error
        ? `Maker reported a problem with this run: ${error}`
        : "";
  return { frame: captured, ...(notes ? { notes } : {}) };
}
