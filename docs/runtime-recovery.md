# Preview isolation and service recovery

A missing project import is a compilation error inside that project's preview.
It must leave project lists, file access, conversations, and other projects
available. A missing package-manager executable must likewise fail the preview
request rather than exit the daemon.

The daemon allows up to 60 seconds for initialization hooks. First-run
preinstalled plugin extraction and local state loading can exceed Fastify's
default ten-second timeout on Windows; the longer budget keeps that work from
aborting an otherwise healthy desktop startup.

## Preview lifecycle

See [startup configuration](preview-runtime.md#startup-configuration) for
package-manager selection, executable checks, and installation behavior.

Spawn errors, early exits, readiness timeouts, cancellation, and exits after
startup are handled throughout the child lifecycle. Output is bounded and
included in the project error. Superseded launches cannot publish late state.
Stopping a preview closes its proxy and terminates the process group, including
descendants. Desktop-owned daemons register those groups over private IPC so
Electron can clean them up after an unexpected daemon exit.

Compilation and browser errors leave the development server alive while project
code is repaired. [Preview diagnostics](preview-runtime.md#pages-diagnostics-and-saved-games)
defines report validation, clearing, and bridge limits. Recovery controls remain
available when the bridge cannot run.

## Desktop recovery

Electron supervises its own daemon. It permits two automatic restarts in a
rolling 60-second window, then shows a manual **Restart service** action.
Concurrent restart requests share a launch. Normal application shutdown does
not restart the service. This handles process exits; it does not detect a daemon
that remains alive but stops responding.

Each launch has a generation and a current HTTP address/token. The renderer
updates its connection without reloading the window, aborts old SSE connections,
and resets event cursors because event IDs belong to a daemon generation.
The initial desktop state is read before mounting views, avoiding a duplicate
startup load. The last ready generation is shared by all views. Project and
conversation state are read again from disk. Other pages refresh
their reads without remounting editable views; existing settings drafts remain
intact. Preview, workspace, conversation, and application React error boundaries
provide local retry controls for rendering failures.

Recovery does not replay failed mutations, automatically restart the current
project's preview, or resume publication. Newly opened projects retain their
normal automatic preview behavior. An initial message that had not been sent before recovery
is retained with an explicit **Send original message** action, including its
attachment references. Newly requested messages remain available after recovery.
The project preview shows **Start preview** after service recovery. Human game
players and agent playtests attached to the old service are closed.

Browser-only development retains its existing daemon address and reconnect
behavior. It has no Electron supervisor or service-restart bridge.

## Validation scenarios

- A Bun project under a desktop PATH without Bun returns a preview error while
  `/health`, project lists, and workspace files remain accessible.
- An executable removed between preflight and spawn produces one local error.
  Startup timeout, process exit, cancellation, and replacement release children.
- A Vite project importing a missing CSS file keeps its server and HMR alive.
  Creating that file recovers the preview. Runtime exceptions stay in the iframe;
  repairing the script removes the old error without losing host input.
- Replacing a broken entry point clears its obsolete error on navigation or HMR;
  late old-page reports and foreign-origin reports cannot restore it.
- A root page returning HTTP 500 still counts as a listening server. Its content
  error remains visible without terminating the development process.
- Repeated real daemon crashes exhaust the automatic restart budget. Manual
  restart reconnects with the new address; shutdown does not relaunch it.
- Registered detached previews terminate after a daemon crash. SSE receives
  new low-numbered events after its generation changes.
- Home and conversation inputs stay mounted during recovery; offline mutations
  are rejected and never queued for automatic replay.
- Only the project retained through recovery pauses its preview. Later projects
  start normally, plugin details load once, and loaded configuration drafts remain intact.

Tests cover these behaviors in `preview.test.ts`, `preview-proxy.test.ts`,
`daemon-supervisor.test.ts`, `runtime-recovery.test.tsx`, and related API tests.
macOS process behavior and real Vite browser recovery are verified locally.
Windows command quoting and `taskkill` cleanup require validation on Windows.
