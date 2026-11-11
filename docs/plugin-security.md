# Plugin security model

What a plugin can and can't do, what the person approves, and what OhMyGame
doesn't protect against yet. [plugins.md](plugins.md) has the details of each
part; this page is the summary to read before adding, publishing or reviewing
a plugin.

## Two kinds of code

| | Panels and pages | Native code |
| --- | --- | --- |
| Where it runs | A frame in the app, served by its own server, never the daemon's | An extension host: a Node child process per project (`src/daemon/extension-hosts.ts`) |
| What limits it | The frame's sandbox and CSP | Nothing: it is fully trusted |
| What it reaches | Only what the bridge (`@ohmygame/plugin-ui`) offers and the manifest allows | Everything the person's account can: files, network, processes |

**Panels.** The frame has only `allow-scripts`, so its origin is opaque. The
page's CSP allows no inline scripts, no `connect-src`, no forms and no other
frame ancestors (`src/daemon/plugin-ui-server.ts`), and the desktop app keeps
the frame within its plugin version's files (`src/desktop/window.ts`). A page
talks to the app only through its MessageChannel; each request is checked
against the plugin's approved capabilities (`src/shared/plugin-ui-protocol.ts`),
and toasts and questions are rate limited. Project files reach a page only
with `project.files`, never hidden files, agent instructions, `ohmygame.json`
or links, and every change is one the person can undo.

**Native code** is a plugin's `native` entry, its tools, commands and project
type hooks. The host runs it with the project's process environment
(`projectProcessEnvironment`), so it doesn't inherit the daemon's token or
settings, but it is not sandboxed: it can read and write anything the person
can. `capabilities.network` and `capabilities.processes` limit the MCP
servers the manifest declares, not what native code does by itself. Treat a
plugin that asks for `native` as you would an app you install.

Community plugins may carry native code. The add review and a project's
Plugins sheet say so plainly, and nothing native runs until the person
approves `native` for that plugin.

## What the person approves

Adding a package allows nothing (`PluginGrants`). What the manifest asks for
(`capabilityGrants`) waits until the person approves it on the plugin's page
or when they turn it on in a project:

| Grant | Allows |
| --- | --- |
| `native` | Running its native entry in the extension host, with no limits |
| `project.files:read`, `project.files:write` | Its pages reading, or also changing, the project's files |
| `project.selection` | Its pages seeing what is selected in the project |
| `composer` | Its pages filling the message box |
| `agent` | Reserved for plugins that work with the agent |
| `secrets` | Its native code and MCP servers getting the secret settings the person saves |
| `network:<host>` | Its HTTP MCP servers reaching that host |
| `process:<command>` | Its local MCP servers starting that command |

A project's own panel ([project panels](plugins.md#project-panels)) asks the
same way for the page grants above, and for `net` hosts its page may fetch
from through the daemon, each time its `panel.json` asks for something else.
What was allowed stays with the app's data for that project, so a project that
comes from someone else asks again.

A plugin that only adds Skills asks for nothing, so it applies once added.
An update asks again only for what the new version adds (`newAsks`). Uninstalling
a plugin's last version forgets what was allowed.

## Who can publish what

- The publishers `ohmygame` and `personal` can't be added from outside the
  app (`assertAddablePlugin`), so no package stands in for a bundled plugin or
  one the Plugin Builder made. The one exception is OhMyGame's own plugins
  from its `@ohmygame` npm scope, on npmjs or npmmirror, which only the
  OhMyGame organization can publish to, and a folder in development. GitHub,
  a file, a plain folder and another registry can claim any publisher, so
  they can't use `ohmygame`. Such a package never replaces a bundled plugin
  of the same id: it comes from another source (below). Keep each
  `ohmygame/` id either bundled or on npm, never both: a plugin that moves
  between them takes a new id, since one installed from npm stays beside the
  bundled copy and its newer version wins.
- A package joins an installed plugin only from the same source, the same
  npm scope or GitHub repository; from anywhere else the person uninstalls
  it first, which clears its approvals and settings. Settings and data kept
  at uninstall go back only to that same source.
- Adding reads the source again and refuses a package whose digest isn't the
  one reviewed. Nothing in a package runs while it's read, so npm install
  scripts don't apply.
- The market checks npm's signature over each listed version. The index can
  reject or block a version, which then can't be added. A version blocked
  after it was installed gets a badge and a warning, but stays on until the
  person uninstalls it: a takedown warns, it doesn't turn plugins off.
- Market icons and screenshots come through the daemon, not the page: only
  images the current index lists, from the index's own host, checked to be a
  PNG, JPEG, WebP or a static SVG, and served with `nosniff` and a sandboxing
  CSP. An index can't make the app read from anywhere else.

## Credentials and logs

- A plugin's settings, secrets among them, are in one file readable only by
  the person (`src/daemon/plugin-values.ts`, mode `0600`). The renderer only
  learns whether a secret is set; native code gets secrets only with
  `secrets`. Connections' secrets are encrypted with a private key file (see
  [Connections](plugins.md#connections)).
- A plugin's log (`src/daemon/plugin-logs.ts`) is kept in memory and goes
  through `redactCredentials` before the app shows or copies it: the plugin's
  saved secrets, bearer and basic tokens, `token=`-style values, URL passwords,
  and common key formats become `[redacted]`. A failed tool's or command's
  error loses the plugin's saved secrets before it reaches a toast, a page or
  an agent. It can't know every format, so it is a safety net, not a promise.

## When something goes wrong

A plugin blamed for three host crashes or hangs within five minutes is
quarantined; a panel that stops answering can be reloaded or turned off; and
safe mode starts the app with every plugin off. See
[When a plugin misbehaves](plugins.md#when-a-plugin-misbehaves).

## Not covered yet

- Native code isn't sandboxed or limited to its declared hosts and commands.
- A plugin's settings file isn't encrypted; anything running as the person
  can read it.
- Packages added by name or from GitHub outside the market aren't reviewed
  or signature checked beyond the registry's checksum or the pinned commit.
  A registry the person enters by address is trusted for that checksum like
  npm is.
- One project's extension host runs all of that project's native plugins, so
  they can reach each other's memory and data folders.
- There is no remote access yet. If plugins are ever used from another
  device, each request from there would need the same grants checked again
  on the daemon, and native code would still run only on this computer.
