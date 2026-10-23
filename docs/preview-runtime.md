# Preview configuration and lifecycle

Web Game and newly created General Game projects have browser preview enabled,
except projects that select a plugin external preview.
New General projects open on Design; prompt-based creation also keeps chat open.
Existing General projects keep their saved switch, and older projects without a
switch remain disabled. **Project settings**, available from Design, Code and
Preview, controls Web preview, Play and Web playtesting. Design's separate
**Default models** button controls generation models. Neither setting selects
or installs a game engine.

## Startup configuration

Run settings are saved per project and copied when duplicating it. Startup
configuration and Playtest defaults are visible immediately, with aligned pairs
of fields. Infrequent port/argument and background cleanup controls are collapsed;
only fields relevant to the selected startup mode are shown. Configuration
inspection runs while the dialog is open and Web preview is enabled. Inactive
mode drafts do not block inspection or saving. Disabling Web preview preserves
the saved configuration and ignores disabled drafts.
**Startup directory** stays inside the workspace, including after resolving
symlinks. Preview modes are:

| Mode | Behavior |
| --- | --- |
| Auto | Run the configured package script when available; otherwise serve `index.html`. |
| Package script | Run the configured script, `dev` by default. |
| Static files | Serve the selected folder's `index.html` without installing dependencies. |
| Custom command | Run a local server command in the selected directory, without a Node dependency install. |

Static directory index pages redirect to a trailing-slash URL while preserving
the query string, so relative scripts and other assets resolve from that directory.
Directories without an index return 404; missing extensionless application routes
can still fall back to the root `index.html` when the request accepts HTML.
Static file media types are matched without regard to extension case, so module
scripts, stylesheets and WebAssembly also load with names such as `main.JS`,
`style.CsS` and `game.WASM`. This does not change filesystem path matching.
Static files support byte ranges on GET for media seeking. HEAD ignores Range
and returns the complete file's headers without a response body.

Custom commands can use `{host}` and `{port}`. The process also receives `HOST`,
`PORT` and `BROWSER=none`. Its server must listen on that port. Advanced settings
allow a fixed upstream port and a JSON array of package-script arguments, with
the same placeholders. Leaving arguments empty selects framework defaults;
`[]` explicitly disables them. Vite, Next, Astro, Nuxt and webpack receive their
own supported flags; unknown scripts receive the environment variables only.

Package-manager selection uses the explicit setting, `package.json.packageManager`,
lockfile, then npm. Settings display the detected manager and its source, and
check availability without running project code or installing dependencies.
Missing Bun/pnpm/Yarn remains an actionable configuration error rather than
silently changing managers. The packaged app includes Node/npm; other managers
must be available to the application. Before installation changes `node_modules`,
the selected executable is checked against the environment passed to the child.

Dependencies install at the owning workspace/lockfile root. Dependency manifests,
workspace definitions and lockfiles form a fingerprint; dependency or manager
changes reinstall, while changes only to scripts preserve installed modules.
Workspace dependency checks support hoisted packages. Discovery follows declared
package patterns and exclusions, with cancellation checks during inspection.
Package-manager selection and its displayed source come from the same resolution.
Known native launchers such as Electron, Tauri and Godot are not treated as Web
servers; configure a separate browser script or command for their Web output.
Failed or cancelled installs leave a pending marker for a clean retry.
**Reinstall dependencies and restart** forces that retry. Installation has a
two-minute limit; the server has
30 seconds to respond after launch. The log panel shows phases, elapsed startup
time, directory, command, manager and the last 8 KiB of process output.

## Automatic policy and idle collection

**Automatic preview** defaults to on. Opening a project creates an editor lease
and starts a runnable preview. Files are observed while a project has users;
when output becomes runnable, automatic preview starts. Agent completion uses
the same policy and requires an observed file change. Checkpoint snapshots leave
running previews and unfinished launches alone, so a conversation without file
edits does not restart the game. Source edits use HMR or static file refresh;
for a server without hot reload, use **Restart preview service** after changing
its code. A failed startup does not repeatedly retry without a change. Before a
workspace has any project files (hidden entries and `node_modules`, `dist` or
`build` do not count), an automatic check that finds nothing runnable stays
waiting without an error, so a new project shows the empty preview. Once files
exist, the waiting state keeps the reason, such as a
missing dev script; Start and Play always report it. Generated dependencies, hidden/build folders and common
runtime log/PID/temp files do not trigger retries.

**Stop preview** cancels installation/startup or stops the running service.
That manual pause survives reopening the project during the current application
session; file changes and agent completion respect it. **Start preview** or Play
resumes it. Service recovery also pauses automatic startup until the user resumes.
Disabling automatic preview affects future starts, not an already running game.
Inspection and launch are one cancellable operation: stopping, disabling automatic
startup or losing the last lease cancels an unfinished automatic launch. An explicit
Start/Play request takes over that launch under manual policy. Reopening during idle
cleanup waits for the old server to close before starting again.
If the replacement fails configuration inspection, the closed preview remains
stopped and its old URL is cleared.
Saving viewport, default route, automatic policy or idle policy does not restart
the server. Changing effective launch settings restarts a currently active server.

The editor renews its lease every 20 seconds. Preview, Play, AI test and external
browser documents have separate leases, renewed by the browser bridge. Closing
a page or leaving a project releases its lease. Abandoned leases expire after
75 seconds, so a disappeared window cannot retain a server indefinitely.

**Stop unused preview after** defaults to five minutes with no users. It can be
set to 1–60 minutes or **Keep running**. A live Play or test window keeps its
server running even after leaving the editor. Idle collection runs every ten
seconds; manually starting an unused server is subject to the same timeout.
Deleting a project immediately closes its watcher, proxy, refresh streams and
child processes.

## Pages, diagnostics and saved games

The project owns one loopback proxy. Its port is saved in `preview-origin.json`
outside the workspace, preserving the browser origin across normal restarts and
application relaunches. If another process occupies that port, an available port
is used and saved; browser storage at the previous origin cannot migrate
automatically. Duplicated projects receive a separate origin.

Page reload and server restart are separate controls. Internal navigation updates
the toolbar without reloading the game. The desktop editor owns one human game
WebContentsView per project. Play moves that view into a separate native window;
closing Play returns it to Preview. Both directions preserve the same document,
current route, in-memory state, localStorage and IndexedDB. Refresh explicitly
recreates the game document at its current route. A minimal host page, with no
editor preload or daemon credentials, keeps the editor's top-level site so existing
Preview saves remain available. Older standalone Play saves stay in their separate
storage context and are not merged. Browser builds continue to use an iframe and
separate popup, which reload the game on switching. Static file changes reload
active pages through a local event
stream, while development servers retain their own HMR protocol.

HTTP readiness and content diagnostics are separate: a responding server can
still have compilation or runtime errors. The proxy forwards HTTP and HMR;
failed module responses and browser exceptions or rejected promises update
daemon-owned diagnostics through project events without stopping the server.

Desktop Preview and human Play share a client/document identity; the diagnostic
source follows the view's current window without reloading it. AI tests and external
pages have their own identities and storage contexts. The editor shows the active
human game's diagnostic. Errors from other windows remain available in the log
panel. Reports must match the proxy origin and current document. Successful module
responses, navigation, HMR success and close clear only that client's errors,
including when a broken module was removed. Late reports and module responses
from superseded documents are ignored. Diagnostic and document maps are bounded,
and each active document has at most one refresh stream. Automatic project-cover
capture pauses while an error is visible.

The proxy removes internal tracking parameters before forwarding requests.
Same-origin Origin/Referer and upstream redirects follow the proxy address;
foreign origins and external redirects retain their original semantics.
Uncaught JavaScript exceptions, rejected promises and compilation failures can
be copied or inserted into the Agent composer using **Ask Agent to fix**. This
preserves the draft and does not send a message. Source links open the relevant
workspace file when its path can be identified.

Browser diagnostics, static refresh and external-page leases depend on an external
classic script injected before project scripts into uncompressed HTML up to 2 MiB.
It preserves CSP, including an existing nonce, and uses its own function scope to
avoid project-global collisions. Larger or compressed pages retain their original
representation; restrictive CSP can block the bridge. Editor leases, service logs
and recovery controls remain available. This proxy is intended for local HTTP
development, not a full production reverse proxy.

Preview state is delivered through one `preview.updated` event containing the
complete runtime state. Browser reports use a typed message envelope for activity,
navigation, lifecycle and diagnostics; obsolete standalone diagnostic messages
are not accepted.

## External plugin preview

A project's optional `integration` selects its plugin and `external` presentation.
These projects expose View with the plugin's native preview controls and do not
acquire Web leases or create a Web player. Browser runtime configuration and
leases retain their existing lifecycle. See [plugin integrations](plugins.md#optional-project-integrations)
for the adapter contract and Maker's current limits. External controls mount only
while View is visible; they do not capture or embed the native game window.
When the connection cannot be used, disconnecting the plugin there stops its
native preview and returns the project to ordinary General settings with Web
preview off.
