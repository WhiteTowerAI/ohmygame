// The TapTap Maker panel: prepare the CLI, sign in, create or connect the
// Maker project, and control the native preview. Everything runs through the
// plugin's commands; a sign-in link opens through the app's link dialog.
import { connect } from "/_ohmygame/plugin-ui.js";

const TEXT = {
  en: {
    checking: "Checking TapTap Maker…",
    working: "Working…",
    setup: "Environment",
    setupNeeded:
      "Maker's CLI and its Lua diagnostics are prepared once for every project. This downloads them and needs Python 3.8 or later.",
    prepare: "Prepare",
    account: "Account",
    signedOut: "Sign in to your Maker account.",
    signedIn: "Signed in to Maker.",
    signIn: "Sign in",
    signInAgain: "Sign in again",
    project: "Maker project",
    connected: (id) => `Connected to Maker project ${id}.`,
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
    retry: "Try again",
  },
  "zh-CN": {
    checking: "正在检查 TapTap Maker…",
    working: "处理中…",
    setup: "环境",
    setupNeeded:
      "Maker CLI 和它的 Lua 诊断只需准备一次，所有项目共用。准备时会下载它们，需要 Python 3.8 或更高版本。",
    prepare: "准备",
    account: "账号",
    signedOut: "登录你的 Maker 账号。",
    signedIn: "已登录 Maker。",
    signIn: "登录",
    signInAgain: "重新登录",
    project: "Maker 项目",
    connected: (id) => `已连接 Maker 项目 ${id}。`,
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
    retry: "重试",
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
  preview: undefined,
  logs: undefined,
  projects: undefined,
  selected: "",
  busy: undefined,
  progress: "",
  error: "",
  visible: true,
  name: "",
};

const run = (command, input) =>
  host.request("command.run", input === undefined ? { command } : { command, input });

host.on("progress", ({ message }) => {
  if (!state.busy) return;
  state.progress = message;
  render();
});
host.on("visibility", ({ visible }) => {
  state.visible = visible;
  if (visible && !state.busy) void checkPreview();
});

/** Runs one action at a time; its result replaces what it reports. */
async function act(name, work) {
  if (state.busy) return;
  state.busy = name;
  state.progress = "";
  state.error = "";
  render();
  try {
    await work();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.busy = undefined;
    state.progress = "";
    render();
  }
}

const refreshStatus = () =>
  act("status", async () => {
    state.status = await run("status");
    if (state.status.project) await loadPreview();
  });

async function loadPreview(action = "status") {
  state.preview = await run("preview", { action });
  if (action === "logs") state.logs = state.preview.logs ?? "";
}

async function checkPreview() {
  if (state.busy || !state.status?.project) return;
  try {
    state.preview = await run("preview", { action: "status" });
    render();
  } catch {
    // The next action reports a lasting failure.
  }
}

setInterval(() => {
  if (state.visible && state.preview?.status === "running") void checkPreview();
}, POLL_MS);

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (key === "onclick" || key === "onchange") node[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  node.append(...children.filter((child) => child !== undefined && child !== null));
  return node;
}

function button(label, onclick, { primary = false, disabled = false } = {}) {
  return element(
    "button",
    {
      type: "button",
      class: "omg-button",
      "data-variant": primary ? "primary" : undefined,
      disabled: disabled || !!state.busy,
      onclick,
    },
    label,
  );
}

function section(title, ...children) {
  return element("section", {}, element("h2", {}, title), ...children);
}

function render() {
  const { status, preview } = state;
  const parts = [];
  if (!status) {
    parts.push(element("p", { class: "omg-muted" }, state.busy ? text.checking : ""));
    if (!state.busy) parts.push(element("div", { class: "actions" }, button(text.retry, refreshStatus)));
  } else {
    const connection = status.connection;
    if (connection === "needs-setup")
      parts.push(
        section(
          text.setup,
          element("p", {}, text.setupNeeded),
          element("div", { class: "actions" }, button(text.prepare, () => act("prepare", async () => {
            state.status = await run("prepare");
          }), { primary: true })),
        ),
      );
    else
      parts.push(
        section(
          text.account,
          element("p", { class: "status", "data-tone": connection === "ready" ? "good" : undefined }, connection === "ready" ? text.signedIn : text.signedOut),
          element("div", { class: "actions" }, button(connection === "ready" ? text.signInAgain : text.signIn, () => act("sign-in", async () => {
            state.status = await run("sign-in");
          }), { primary: connection !== "ready" })),
        ),
      );
    if (connection === "ready" && !status.project) {
      const chooser = state.projects
        ? state.projects.length
          ? [
              element(
                "select",
                {
                  class: "omg-select",
                  "aria-label": text.choose,
                  onchange: (event) => {
                    state.selected = event.target.value;
                    render();
                  },
                },
                element("option", { value: "" }, text.choose),
                ...state.projects.map((project) =>
                  element("option", { value: project.id, selected: project.id === state.selected }, project.name),
                ),
              ),
              button(text.bind, () => act("bind", async () => {
                state.status = await run("bind", { projectId: state.selected });
                if (state.status.project) await loadPreview();
              }), { disabled: !state.selected }),
            ]
          : [element("span", { class: "omg-muted" }, text.noProjects)]
        : [button(text.load, () => act("projects", async () => {
            state.projects = (await run("projects")).projects;
          }))];
      parts.push(
        section(
          text.project,
          element("p", {}, text.createHint(state.name)),
          element("div", { class: "actions" }, button(text.create, () => act("create", async () => {
            state.status = await run("create", { name: state.name });
            if (state.status.project) await loadPreview();
          }), { primary: true, disabled: !state.name.trim() })),
          element("div", { class: "actions" }, ...chooser),
        ),
      );
    }
    if (status.project) {
      parts.push(section(text.project, element("p", { class: "status", "data-tone": "good" }, text.connected(status.project.id))));
      const label = { running: text.running, stopped: text.stopped, missing: text.missing, error: text.failed }[preview?.status] ?? "";
      const previewAction = (action) => () => act(action, () => loadPreview(action));
      parts.push(
        section(
          text.preview,
          element("p", { class: "omg-muted" }, text.previewHint),
          preview ? element("p", { class: "status", "data-tone": preview.status === "running" ? "good" : preview.status === "error" ? "bad" : undefined }, label) : undefined,
          preview?.message ? element("p", { class: "error" }, preview.message) : undefined,
          element(
            "div",
            { class: "actions" },
            preview?.status === "missing"
              ? button(text.install, previewAction("install"), { primary: true })
              : preview?.status === "running"
                ? button(text.refresh, previewAction("refresh"), { primary: true })
                : button(text.start, previewAction("start"), { primary: true }),
            preview?.status === "running" ? button(text.stop, previewAction("stop")) : undefined,
            button(text.logs, previewAction("logs")),
            button(text.check, refreshStatus),
          ),
          state.logs === undefined ? undefined : element("pre", {}, state.logs || text.noLogs),
        ),
      );
    }
  }
  if (state.busy && status) parts.push(element("p", { class: "progress", role: "status" }, state.progress || text.working));
  if (state.error) parts.push(element("p", { class: "error", role: "alert" }, state.error));
  root.replaceChildren(...parts);
}

state.name = (await host.request("project.info")).name ?? "";
render();
await refreshStatus();
