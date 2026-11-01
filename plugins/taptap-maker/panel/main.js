// The TapTap Maker panel: a flow of steps, preparing the CLI, signing in,
// creating or connecting the Maker project, then the native preview. It is
// built from the app's page components; their command buttons run the
// plugin's commands and show each one's progress and failure. A sign-in link
// opens through the app's link dialog.
import { connect } from "/_ohmygame/plugin-ui.js";

const TEXT = {
  en: {
    checking: "Checking TapTap Maker…",
    statusFailed: "Couldn't check TapTap Maker",
    retry: "Try again",
    setup: "Prepare Maker",
    setupNeeded:
      "Maker's CLI and its Lua diagnostics are prepared once for every project. This downloads them and needs Python 3.8 or later.",
    setupDone: "Maker's tools are ready.",
    prepare: "Prepare",
    account: "Sign in",
    signedOut: "Sign in to your Maker account. The sign-in opens in your browser.",
    signedIn: "Signed in to Maker.",
    signIn: "Sign in",
    signInAgain: "Sign in again",
    project: "Create or connect a Maker project",
    connected: (name) => `Connected to Maker project “${name}”.`,
    createHint: (name) => `Create a new Maker project named “${name}”, or connect one you already have.`,
    create: "Create Maker project",
    load: "Choose an existing project",
    choose: "Choose a project",
    bind: "Connect",
    noProjects: "This account has no Maker projects yet.",
    preview: "Preview",
    previewHint: "The game opens in its own Maker Runtime window.",
    running: "Running",
    stopped: "Stopped",
    missing: "Maker Runtime isn't installed",
    failed: "Didn't start",
    install: "Install Runtime",
    start: "Start",
    refresh: "Restart with changes",
    stop: "Stop",
    logs: "Show logs",
    check: "Check again",
    noLogs: "No log lines yet.",
  },
  "zh-CN": {
    checking: "正在检查 TapTap Maker…",
    statusFailed: "无法检查 TapTap Maker",
    retry: "重试",
    setup: "准备 Maker",
    setupNeeded:
      "Maker CLI 和它的 Lua 诊断只需准备一次，所有项目共用。准备时会下载它们，需要 Python 3.8 或更高版本。",
    setupDone: "Maker 工具已就绪。",
    prepare: "准备",
    account: "登录",
    signedOut: "登录你的 Maker 账号，会在浏览器中打开登录页面。",
    signedIn: "已登录 Maker。",
    signIn: "登录",
    signInAgain: "重新登录",
    project: "新建或连接 Maker 项目",
    connected: (name) => `已连接 Maker 项目“${name}”。`,
    createHint: (name) => `新建一个名为“${name}”的 Maker 项目，或者连接你已有的项目。`,
    create: "新建 Maker 项目",
    load: "选择已有项目",
    choose: "选择项目",
    bind: "连接",
    noProjects: "这个账号还没有 Maker 项目。",
    preview: "预览",
    previewHint: "游戏会在单独的 Maker Runtime 窗口里打开。",
    running: "运行中",
    stopped: "已停止",
    missing: "还没有安装 Maker Runtime",
    failed: "没有启动",
    install: "安装 Runtime",
    start: "启动",
    refresh: "带上改动重新启动",
    stop: "停止",
    logs: "查看日志",
    check: "重新检查",
    noLogs: "还没有日志。",
  },
};

/** How often a running preview is checked, to notice its window closing. */
const POLL_MS = 5000;

const host = await connect();
const text = TEXT[host.locale] ?? TEXT.en;
const root = document.getElementById("maker");
document.documentElement.lang = host.locale;

const state = {
  status: undefined,
  statusError: "",
  preview: undefined,
  logs: undefined,
  projects: undefined,
  selected: "",
  visible: true,
  name: "",
  /** Commands the panel's buttons are running; nothing redraws meanwhile. */
  running: 0,
};

const request = (command, input) =>
  host.request("command.run", input === undefined ? { command } : { command, input });

host.on("visibility", ({ visible }) => {
  state.visible = visible;
  if (visible) void checkPreview();
});

document.addEventListener("omg-command-start", () => state.running++);
for (const type of ["omg-command-result", "omg-command-error"])
  document.addEventListener(type, () => {
    state.running = Math.max(0, state.running - 1);
  });

async function refreshStatus() {
  state.statusError = "";
  try {
    state.status = await request("status");
    if (state.status.project) state.preview = await request("preview", { action: "status" });
  } catch (error) {
    state.statusError = error instanceof Error ? error.message : String(error);
  }
  render();
}

async function checkPreview() {
  if (state.running || !state.status?.project) return;
  try {
    state.preview = await request("preview", { action: "status" });
    if (!state.running) render();
  } catch {
    // The next action reports a lasting failure.
  }
}

setInterval(() => {
  if (state.visible && state.preview?.status === "running") void checkPreview();
}, POLL_MS);

/** An element with attributes and children; `on` maps events to listeners, `props` sets properties. */
function h(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "on") for (const [type, listener] of Object.entries(value)) node.addEventListener(type, listener);
    else if (key === "props") Object.assign(node, value);
    else if (value !== undefined && value !== false) node.setAttribute(key, value === true ? "" : String(value));
  }
  node.append(...children.flat().filter((child) => child !== undefined && child !== null && child !== false));
  return node;
}

/** A button running one of the plugin's commands; `done` takes its result, then the panel redraws. */
function command(label, name, { input, variant, disabled, done } = {}) {
  return h(
    "omg-command-button",
    {
      command: name,
      variant,
      disabled,
      props: input === undefined ? {} : { input },
      on: {
        "omg-command-result": async (event) => {
          await done?.(event.detail.result);
          render();
        },
      },
    },
    label,
  );
}

/** A finished step returns the status; the preview's state comes with a project. */
async function takeStatus(status) {
  state.status = status;
  if (status.project) state.preview = await request("preview", { action: "status" }).catch(() => undefined);
}

const row = (...children) => h("omg-stack", { direction: "row", wrap: true }, ...children);
const paragraph = (value) => h("p", {}, value);

function setupStep(connection) {
  const done = connection !== "needs-setup";
  return h(
    "omg-step",
    { heading: text.setup, state: done ? "done" : "current" },
    done ? h("span", { slot: "summary" }, text.setupDone) : undefined,
    paragraph(text.setupNeeded),
    row(command(text.prepare, "prepare", { variant: "primary", done: takeStatus })),
  );
}

function accountStep(connection) {
  const ready = connection === "ready";
  return h(
    "omg-step",
    { heading: text.account, state: ready ? "done" : connection === "needs-setup" ? "pending" : "current" },
    ready
      ? h(
          "omg-stack",
          { slot: "summary", direction: "row", wrap: true, justify: "between" },
          h("span", {}, text.signedIn),
          command(text.signInAgain, "sign-in", { variant: "ghost", done: takeStatus }),
        )
      : undefined,
    paragraph(text.signedOut),
    row(command(text.signIn, "sign-in", { variant: "primary", done: takeStatus })),
  );
}

function projectStep(status) {
  const { connection, project } = status;
  // Choosing a project changes only the Connect button: a redraw would
  // replace a button that is running.
  const bind = command(text.bind, "bind", { input: { projectId: state.selected }, disabled: !state.selected, done: takeStatus });
  const chooser = state.projects
    ? state.projects.length
      ? [
          h(
            "omg-select",
            {
              "aria-label": text.choose,
              value: state.selected,
              on: {
                change: (event) => {
                  state.selected = event.currentTarget.value;
                  bind.input = { projectId: state.selected };
                  bind.disabled = !state.selected;
                },
              },
            },
            h("option", { value: "" }, text.choose),
            state.projects.map((item) => h("option", { value: item.id }, item.name)),
          ),
          bind,
        ]
      : [h("span", { class: "muted" }, text.noProjects)]
    : [
        command(text.load, "projects", {
          done: (result) => {
            state.projects = result.projects;
          },
        }),
      ];
  return h(
    "omg-step",
    { heading: text.project, state: project ? "done" : connection === "ready" ? "current" : "pending" },
    project ? h("span", { slot: "summary" }, text.connected(project.name ?? project.id)) : undefined,
    paragraph(text.createHint(state.name)),
    row(command(text.create, "create", { input: { name: state.name }, variant: "primary", disabled: !state.name.trim(), done: takeStatus })),
    h("omg-stack", { direction: "row", wrap: true, class: "chooser" }, chooser),
  );
}

function previewStep(status) {
  const { preview } = state;
  const ready = status.connection === "ready" && status.project;
  const label = { running: text.running, stopped: text.stopped, missing: text.missing, error: text.failed }[preview?.status];
  const tone = { running: "good", error: "bad", missing: "warning" }[preview?.status];
  const action = (name, label, options = {}) =>
    command(label, "preview", {
      ...options,
      input: { action: name },
      done: (result) => {
        state.preview = result;
        if (name === "logs") state.logs = result.logs ?? "";
      },
    });
  return h(
    "omg-step",
    { heading: text.preview, state: ready ? "current" : "pending" },
    paragraph(text.previewHint),
    label ? h("omg-status", { tone }, label) : undefined,
    preview?.message ? h("omg-banner", { tone: preview.status === "error" ? "bad" : "warning" }, preview.message) : undefined,
    row(
      preview?.status === "missing"
        ? action("install", text.install, { variant: "primary" })
        : preview?.status === "running"
          ? action("refresh", text.refresh, { variant: "primary" })
          : action("start", text.start, { variant: "primary" }),
      preview?.status === "running" ? action("stop", text.stop) : undefined,
      action("logs", text.logs),
      command(text.check, "status", { variant: "ghost", done: takeStatus }),
    ),
    state.logs === undefined ? undefined : h("omg-log", { follow: true, empty: text.noLogs, props: { text: state.logs } }),
  );
}

function render() {
  const { status } = state;
  if (!status) {
    root.replaceChildren(
      state.statusError
        ? h(
            "omg-banner",
            { tone: "bad", heading: text.statusFailed },
            state.statusError,
            h("omg-button", { slot: "actions", on: { click: () => void refreshStatus() } }, text.retry),
          )
        : h("omg-status", { tone: "busy" }, text.checking),
    );
    return;
  }
  root.replaceChildren(
    h("omg-steps", {}, setupStep(status.connection), accountStep(status.connection), projectStep(status), previewStep(status)),
  );
}

state.name = (await host.request("project.info")).name ?? "";
render();
await refreshStatus();
