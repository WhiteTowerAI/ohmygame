import { connect } from "/_ohmygame/plugin-ui.js";

const TEXT = {
  en: {
    tableVersion: "Version",
    tableStatus: "Status",
    tableAction: "Action",
    tableDate: "Created",
    connection: "Connection",
    switchGame: "Choose a different game",
    localFile: "Local material file",
    uploadMaterial: "Upload material with agent",
    mediaSet: "media items",
    mediaReady: "Media uploaded",
    immediate: "Release after approval",
    refresh: "Refresh",
    setup: "CLI settings",
    login: "Sign in with agent",
    missing: "TapTap CLI is unavailable",
    signedOut: "Sign in to TapTap",
    signedIn: "Signed in",
    developers: "Load developers",
    developer: "Developer",
    game: "Game",
    search: "Search games",
    keyword: "Game name",
    connect: "Connect",
    create: "Create game with agent",
    noGames: "No games found",
    previous: "Previous",
    next: "Next",
    upload: "H5 upload",
    details: "Store page",
    releases: "Versions",
    build: "Web build folder",
    orientation: "Orientation",
    landscape: "Landscape",
    portrait: "Portrait",
    prepare: "Prepare package",
    send: "Upload package",
    confirm: "Upload this H5 package?",
    confirmAction: "Upload",
    prepared: "Package preflight passed",
    emptyUpload: "No uploaded packages yet",
    unknown: "Outcome unknown — reconcile before retrying",
    uploading: "Uploading…",
    uploaded: "Uploaded; see Versions for binding and review",
    ready: "Parsed; not necessarily bound",
    processing: "Parsing…",
    failed: "Parsing failed",
    check: "Check result",
    fix: "Recover with agent",
    module: "Section",
    basic: "Basic information",
    assets: "Images and video",
    author: "Developer information",
    platforms: "Distribution",
    schedule: "Release settings",
    promotion: "Recommendations",
    edit: "Update with agent",
    empty: "No data available",
    required: "Required",
    optional: "Optional",
    suggested: "Suggested",
    unfilled: "Not filled",
    package: "H5 packages",
    bound: "Bound to main slot",
    bind: "Bind with agent",
    release: "Prepare release with agent",
    noVersions: "No versions yet",
    issues: "Items to resolve",
    warnings: "Warnings",
    noIssues: "No reported blockers",
    unknownIssues: "Could not confirm blockers",
    connectFirst: "Connect a TapTap game to continue",
    loading: "Loading…",
    draft: "Draft",
    reviewing: "In review",
    scheduled: "Scheduled",
    online: "Online",
    offline: "Offline",
    rejected: "Rejected",
    cancelled: "Schedule cancelled",
    uploadHint:
      "Use the finished web build containing index.html. This does not build the project.",
    notice:
      "Refresh after changes made by the agent or in the developer console.",
    working: "Working…",
    continue: "Review and release with agent",
  },
  "zh-CN": {
    tableVersion: "版本",
    tableStatus: "状态",
    tableAction: "操作",
    tableDate: "创建日期",
    connection: "连接",
    switchGame: "选择其他游戏",
    localFile: "本地素材文件",
    uploadMaterial: "让 Agent 上传素材",
    mediaSet: "项素材",
    mediaReady: "已上传素材",
    immediate: "审核通过后上线",
    refresh: "刷新",
    setup: "CLI 设置",
    login: "让 Agent 帮助登录",
    missing: "TapTap CLI 不可用",
    signedOut: "请登录 TapTap",
    signedIn: "已登录",
    developers: "加载厂商",
    developer: "厂商",
    game: "游戏",
    search: "查找游戏",
    keyword: "游戏名称",
    connect: "连接",
    create: "让 Agent 创建游戏",
    noGames: "没有找到游戏",
    previous: "上一页",
    next: "下一页",
    upload: "H5 上传",
    details: "游戏资料",
    releases: "版本",
    build: "网页构建目录",
    orientation: "屏幕方向",
    landscape: "横屏",
    portrait: "竖屏",
    prepare: "准备包体",
    send: "上传包体",
    confirm: "上传这个 H5 包体？",
    confirmAction: "上传",
    prepared: "包体预检通过",
    emptyUpload: "还没有上传记录",
    unknown: "结果待核对，请勿重复上传",
    uploading: "正在上传…",
    uploaded: "已上传，绑定与提审状态见版本",
    ready: "解析完成，绑定状态需另行确认",
    processing: "正在解析…",
    failed: "解析失败",
    check: "查询结果",
    fix: "让 Agent 核对任务",
    module: "资料分类",
    basic: "基础信息",
    assets: "图片与视频",
    author: "开发者信息",
    platforms: "分发设置",
    schedule: "发布设置",
    promotion: "首页推荐",
    edit: "让 Agent 更新资料",
    empty: "暂无资料",
    required: "必填",
    optional: "选填",
    suggested: "建议填写",
    unfilled: "未填写",
    package: "H5 包体",
    bound: "已绑定主包体",
    bind: "让 Agent 绑定",
    release: "让 Agent 准备发版",
    noVersions: "还没有版本",
    issues: "待解决事项",
    warnings: "注意事项",
    noIssues: "未报告阻塞项",
    unknownIssues: "无法确认阻塞项",
    connectFirst: "请先连接 TapTap 游戏",
    loading: "正在加载…",
    draft: "草稿",
    reviewing: "审核中",
    scheduled: "定时上线",
    online: "已上线",
    offline: "已下架",
    rejected: "审核未通过",
    cancelled: "已撤销定时上线",
    uploadHint:
      "选择已完成构建、直接包含 index.html 的目录，此操作不会构建项目。",
    notice: "Agent 或开发者后台修改后，刷新查看最新状态。",
    working: "正在处理…",
    continue: "让 Agent 继续提审发布",
  },
};
Object.assign(TEXT["en"], {
  switchGame: "Switch game",
  upload: "Builds",
  details: "Store page",
  releases: "Versions",
  send: "Check and upload",
  bind: "Use in draft",
  uploadHint:
    "Choose a finished web build. The panel packages and checks it for TapTap.",
  ready: "Parsing complete",
  uploaded: "Uploaded · awaiting parsing",
  source: "Project builds",
  rescan: "Rescan project",
  otherFolder: "Choose another folder",
  noBuild: "No web build found",
  noBuildHint:
    "Build the game first, or enter a project folder containing index.html.",
  buildAgent: "Build with agent",
  recentUploads: "Upload history",
  remotePackages: "Package library",
  currentPackage: "Current draft package",
  notBound: "No package selected",
  localOnly: "Not uploaded",
  files: "files",
  preflighting: "Checking package…",
  preview: "Store preview",
  draftOnly: "Changes are saved to the draft.",
  save: "Save draft",
  saved: "Changes verified in draft",
  unsaved: "Unsaved changes",
  discard: "Discard local edits",
  discardConfirm: "Discard your unsaved changes in this section?",
  discardAction: "Discard",
  keepEdits: "Your local edits are preserved.",
  nothingChanged: "No unsaved changes",
  openConsole: "Developer console",
  account: "Account & settings",
  chooseGame: "Choose a TapTap game",
  selectGame: "Select game",
  chooseHint:
    "Use an existing H5 game. Its original package type is preserved.",
  available: "H5 upload available",
  conflict:
    "H5 declaration conflicts with this game’s current form. Platform support is required.",
  unavailable: "This game currently has no H5 upload target.",
  unknownAvailability: "Could not check H5 upload availability",
  draftVersion: "Draft version",
  requirements: "Required fields",
  missingFields: "to complete",
  noDraft: "No editable draft",
  allFilled: "Required fields filled",
  chooseImage: "Choose image",
  localImage: "From this computer",
  chooseFile: "Choose image file",
  dropImage: "or drop an image here",
  clearFile: "Clear",
  imageFileError: "Choose one PNG, JPEG or WebP image up to 20 MB.",
  imageImportHint:
    "Imported into taptap-materials/ in this project before upload.",
  close: "Close",
  replaceImage: "Replace image",
  addImage: "Add image",
  removeImage: "Remove image",
  projectImages: "Project images",
  noImages: "No project images found",
  imageUpload: "Upload image",
  imageConfirm: "Upload this image to the selected game’s material library?",
  imagePending: "Image uploaded. Save the draft to apply it.",
  imageFailed: "Image preview unavailable",
  moreSettings: "More settings",
  developerWords: "Developer’s words",
  back: "Back",
  partialSave:
    "Some changes could not be verified. Your remaining edits are preserved.",
  boundSuccess: "Package binding verified in the draft",
  bindConfirm: "Use this H5 package in the draft?",
  bindHint:
    "This replaces the draft’s main package. It does not submit review.",
  refreshConflict: "Remote fields have changed. Compare before saving.",
  truncated:
    "Project scan reached its limit. Enter a folder if your build is missing.",
  needsSetup: "Connect TapTap to manage this game",
  noSelection: "No game selected",
  resultUnknown: "Check the existing upload before starting another one.",
  current: "Current",
  useBuild: "Use this build",
  openMaterials: "Manage materials",
  images: "Images",
  cancel: "Cancel",
  loadingPreview: "Loading image…",
  noDescription: "Add a description to preview it here.",
  uploadSafety: "Upload → parse → bind to draft",
  advanced: "Manual folder path",
  size: "Size",
  readinessUnknown: "Readiness unavailable",
  connectedTo: "Connected",
  iosOverrides: "iOS overrides",
  prepareError: "Preflight failed; no upload started",
  page: "Page",
});
Object.assign(TEXT["zh-CN"], {
  switchGame: "切换游戏",
  upload: "游戏包体",
  details: "游戏资料",
  releases: "版本记录",
  send: "检查并上传",
  bind: "用于当前草稿",
  uploadHint: "选择已构建的网页目录，面板会自动打包并检查 TapTap 格式。",
  ready: "解析完成",
  uploaded: "已上传 · 等待解析",
  source: "项目中的网页构建",
  rescan: "重新扫描",
  otherFolder: "选择其他目录",
  noBuild: "未找到网页构建",
  noBuildHint: "先构建游戏，或填写项目内包含 index.html 的目录。",
  buildAgent: "让 Agent 构建",
  recentUploads: "上传记录",
  remotePackages: "包体库",
  currentPackage: "草稿使用的包体",
  notBound: "尚未选择包体",
  localOnly: "尚未上传",
  files: "个文件",
  preflighting: "正在检查包体…",
  preview: "资料预览",
  draftOnly: "修改仅保存到草稿。",
  save: "保存草稿",
  saved: "已核对草稿中的修改",
  unsaved: "有未保存的修改",
  discard: "放弃本地修改",
  discardConfirm: "放弃当前分类中尚未保存的修改？",
  discardAction: "放弃修改",
  keepEdits: "本地修改已保留。",
  nothingChanged: "暂无未保存的修改",
  openConsole: "开发者后台",
  account: "账号与设置",
  chooseGame: "选择 TapTap 游戏",
  selectGame: "选择此游戏",
  chooseHint: "关联已有 H5 游戏，保留它原有的包体类型。",
  available: "可以上传 H5 包体",
  conflict: "H5 声明与游戏当前形态冲突，需要平台支持处理。",
  unavailable: "该游戏当前没有可用的 H5 上传入口。",
  unknownAvailability: "暂时无法确认 H5 上传能力",
  draftVersion: "资料草稿",
  requirements: "必填资料",
  missingFields: "项待补充",
  noDraft: "没有可编辑草稿",
  allFilled: "必填资料已填写",
  chooseImage: "选择图片",
  localImage: "从本机导入",
  chooseFile: "选择图片文件",
  dropImage: "或将图片拖到这里",
  clearFile: "清除",
  imageFileError: "请选择一张不超过 20 MB 的 PNG、JPEG 或 WebP 图片。",
  imageImportHint: "上传前会导入项目的 taptap-materials/ 目录。",
  close: "关闭",
  replaceImage: "替换图片",
  addImage: "添加图片",
  removeImage: "移除图片",
  projectImages: "项目图片",
  noImages: "项目中没有找到图片",
  imageUpload: "上传图片",
  imageConfirm: "将这张图片上传到当前游戏的素材库？",
  imagePending: "图片已上传，保存草稿后应用到资料。",
  imageFailed: "图片暂时无法预览",
  moreSettings: "更多设置",
  developerWords: "开发者的话",
  back: "返回",
  partialSave: "部分修改未能核实，尚未完成的编辑已保留。",
  boundSuccess: "已核对草稿中的包体绑定",
  bindConfirm: "将此 H5 包体用于当前草稿？",
  bindHint: "将替换草稿的主包体，不会提交审核。",
  refreshConflict: "远端资料已变化，请对照后再保存。",
  truncated: "项目扫描已达到上限，未找到的构建可手动填写目录。",
  needsSetup: "连接 TapTap 后管理游戏",
  noSelection: "尚未选择游戏",
  resultUnknown: "请先核对已有上传结果，再开始新的上传。",
  current: "当前使用",
  useBuild: "使用此构建",
  openMaterials: "管理素材",
  images: "图片",
  cancel: "取消",
  loadingPreview: "正在加载图片…",
  noDescription: "填写简介后在这里预览。",
  uploadSafety: "上传 → 解析 → 绑定到草稿",
  advanced: "手动填写目录",
  size: "大小",
  readinessUnknown: "无法确认资料完整度",
  connectedTo: "已连接",
  iosOverrides: "iOS 单独配置",
  prepareError: "包体检查失败，未开始上传",
  page: "页码",
});
const host = await connect();
const t = TEXT[host.locale] ?? TEXT.en;
document.documentElement.lang = host.locale;
const root = document.getElementById("taptap");
root.setAttribute("wide", "");
root.removeAttribute("heading");
const state = {
  busy: false,
  visible: true,
  moduleId: "basic-info",
  modules: {},
  edits: {},
  imageCache: new Map(),
  developer: "",
  page: 1,
  versionPage: 1,
};
const request = (command, input) =>
  host.request("command.run", { command, ...(input ? { input } : {}) });
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "on")
      for (const [event, listener] of Object.entries(value))
        node.addEventListener(event, listener);
    else if (value !== undefined && value !== false)
      node.setAttribute(key, value === true ? "" : String(value));
  }
  node.append(
    ...children
      .flat()
      .filter(
        (value) => value !== undefined && value !== null && value !== false,
      ),
  );
  return node;
}
const p = (text, className = "") => h("p", { class: className }, text);
const row = (...children) => h("div", { class: "row" }, ...children);
const stack = (...children) => h("div", { class: "stack" }, ...children);
const note = (text, tone = "neutral") => h("omg-status", { tone }, text);
const button = (label, action, attrs = {}) =>
  h(
    "omg-button",
    {
      ...attrs,
      "data-fixed-disabled": attrs.disabled ? "true" : "false",
      disabled: attrs.disabled || state.busy,
      on: { click: () => void act(action) },
    },
    label,
  );
const errorBox = h("div", { role: "alert", class: "notice" });
const activity = h("omg-status", { tone: "busy", hidden: true });
const feedback = h("div", { role: "status", "aria-live": "polite" });
const controls =
  "omg-button, omg-input, omg-textarea, omg-select, omg-combobox, omg-pagination, omg-segmented, omg-file-picker, omg-tile";
async function act(action, errorTarget = () => errorBox) {
  if (state.busy) return;
  state.busy = true;
  activity.hidden = false;
  activity.textContent = t.working;
  errorBox.replaceChildren();
  errorTarget().replaceChildren();
  feedback.replaceChildren();
  updateControls();
  try {
    await action();
  } catch (error) {
    errorTarget().replaceChildren(
      h("omg-banner", { tone: "bad" }, error.message || String(error)),
    );
  } finally {
    state.busy = false;
    activity.hidden = true;
    updateControls();
  }
}
function targetPrompt() {
  if (!state.selected) throw new Error(t.connectFirst);
  return `Target TapTap developer ID ${state.selected.developerId}, app ID ${state.selected.appId} (${JSON.stringify(state.selected.title)}). `;
}
const agent = (text, scoped = true) =>
  host.request("composer.fill", {
    text: `Use the taptap-h5-publish skill. ${scoped ? targetPrompt() : ""}${text}`,
  });
const consoleUrl = () =>
  state.selected
    ? `https://developer.taptap.cn/v3/${state.selected.developerId}/app/${state.selected.appId}/store/update`
    : "https://developer.taptap.cn/";
const openConsole = () => host.request("browser.open", { url: consoleUrl() });
const title = h("h1", {}, "TapTap");
const identity = p(t.noSelection, "muted");
const connectionStatus = h("div");
const chooser = h("omg-disclosure", {
  class: "game-chooser",
  heading: t.switchGame,
});
const account = h(
  "omg-popover",
  { class: "account", label: t.account, placement: "bottom-end" },
  stack(
    connectionStatus,
    row(
      button(t.setup, () => request("settings")),
      button(t.login, () =>
        agent(
          "Help me locate the official TapTap CLI and complete browser device login. Do not upload or publish anything.",
          false,
        ),
      ),
    ),
  ),
);
const topbar = h(
  "header",
  { class: "topbar" },
  row(
    h("img", { src: "../assets/icon.svg", alt: "", class: "brand" }),
    stack(title, identity),
  ),
  row(
    button(t.openConsole, openConsole, { variant: "ghost" }),
    h(
      "omg-tooltip",
      { content: t.notice },
      button(t.refresh, refresh, { variant: "ghost" }),
    ),
    account,
  ),
);
const developer = h("omg-combobox", {
  label: t.developer,
  placeholder: t.developer,
  "empty-label": t.empty,
  "loading-label": t.loading,
  on: {
    change: () =>
      void act(async () => {
        try {
          await loadGames(1, developer.value, keyword.value || "");
        } catch (error) {
          developer.value = state.developer;
          throw error;
        }
      }),
  },
});
const keyword = h("omg-input", {
  "aria-label": t.keyword,
  placeholder: t.keyword,
  on: {
    keydown: (event) => {
      if (event.key === "Enter")
        void act(() => loadGames(1, state.developer, keyword.value || ""));
    },
  },
});
const gameList = h("div", { class: "game-list" });
const appPagination = h("omg-pagination", {
  label: t.game,
  "previous-label": t.previous,
  "next-label": t.next,
  on: {
    "omg-page-change": (event) => void act(() => loadGames(event.detail.page)),
  },
});
chooser.append(
  stack(
    p(t.chooseHint, "muted"),
    h(
      "div",
      { class: "search-row" },
      developer,
      keyword,
      button(t.search, () =>
        loadGames(1, state.developer, keyword.value || ""),
      ),
    ),
    gameList,
    appPagination,
  ),
);
chooser.addEventListener("omg-toggle", () => {
  if (chooser.open && !state.developersLoaded && !state.busy)
    void act(loadDevelopers);
});
async function loadDevelopers() {
  const value = await request("developers");
  developer.replaceChildren(
    ...value.developers.map((item) =>
      h("option", { value: item.developer_id }, item.name),
    ),
  );
  state.developersLoaded = true;
  state.developer ||= String(
    state.selected?.developerId ||
      (value.developers.length === 1 ? value.developers[0].developer_id : ""),
  );
  developer.value = state.developer;
  if (state.developer) await loadGames();
}
async function loadGames(
  page = state.page,
  developerId = state.developer,
  search = state.gameKeyword || "",
) {
  if (!developerId) return;
  const value = await request("apps", {
    developerId: Number(developerId),
    page,
    keyword: search,
  });
  state.page = page;
  state.developer = developerId;
  state.gameKeyword = search;
  gameList.replaceChildren(
    ...(value.list.length
      ? value.list.map((item) =>
          h(
            "div",
            { class: "game-row" },
            stack(
              h("strong", {}, item.title),
              p(
                `${item.app_id}${item.status_label ? ` · ${item.status_label}` : ""}`,
                "muted",
              ),
            ),
            button(
              state.selected?.appId === item.app_id
                ? t.connectedTo
                : t.selectGame,
              async () => {
                await persistEdits();
                await request("select", {
                  developerId: Number(state.developer),
                  appId: item.app_id,
                });
                state.modules = {};
                state.edits = {};
                state.versionPage = 1;
                await refreshStatus();
                await restoreEdits();
                await refreshData();
                chooser.open = false;
              },
              { disabled: state.selected?.appId === item.app_id },
            ),
          ),
        )
      : [p(t.noGames, "muted")]),
  );
  appPagination.setAttribute("page", String(state.page));
  appPagination.setAttribute(
    "pages",
    String(Math.max(1, Math.ceil(value.total / value.page_size))),
  );
  appPagination.hidden = value.total <= value.page_size;
}
const summary = h("div", { class: "summary-grid" });
const capabilityView = h("div");
const buildChoices = h("div", { class: "build-list" });
const build = h("omg-input", {
  label: t.build,
  placeholder: "dist",
  on: {
    input: () => {
      renderBuildSelection();
      updateControls();
    },
  },
});
const orientation = h(
  "omg-segmented",
  { label: t.orientation, value: "0", on: { change: () => updateControls() } },
  h("option", { value: "0" }, t.landscape),
  h("option", { value: "1" }, t.portrait),
);
const manualFolder = h("omg-disclosure", { heading: t.advanced }, build);
const preparedView = h("div");
const uploadView = h("div", { class: "stack" });
const libraryView = h("div", { class: "stack" });
const uploadButton = button(
  t.send,
  async () => {
    activity.textContent = t.preflighting;
    let prepared;
    try {
      prepared = await request("prepare", {
        buildFolder: build.value.trim(),
        orientation: Number(orientation.value),
      });
    } finally {
      await refreshStatus();
    }
    const accepted = await host.request("ui.confirm", {
      title: t.confirm,
      message: `${prepared.target.title}\n${prepared.buildFolder || build.value} · ${(prepared.bytes / 1024 / 1024).toFixed(2)} MB · ${prepared.orientation === 0 ? t.landscape : t.portrait}\n${prepared.warnings.join("\n")}`,
      confirmLabel: t.confirmAction,
    });
    if (!accepted) return;
    activity.textContent = t.uploading;
    uploadView.replaceChildren(h("omg-progress", { label: t.uploading }));
    await request("upload", { preparedId: prepared.id });
    await refreshStatus();
    const job = state.status.uploads.find((item) => item.id === prepared.id);
    if (job?.receipt?.artifactId) {
      await request("reconcile", { uploadId: job.id });
      await refreshStatus();
    }
    await loadOverview();
  },
  { variant: "primary" },
);
const buildAgent = button(
  t.buildAgent,
  () =>
    agent(
      "Build this project's web game using its existing engine and scripts. Find the output containing index.html and report that folder. Do not upload or publish.",
      false,
    ),
  { variant: "ghost" },
);
async function discover() {
  state.workspace = await request("discover");
  const candidates = state.workspace.builds;
  buildChoices.replaceChildren(
    ...(candidates.length
      ? candidates.map((item) =>
          h(
            "button",
            {
              class: "build-choice",
              type: "button",
              "data-folder": item.folder,
              "aria-pressed": "false",
              on: {
                click: () => {
                  if (state.busy) return;
                  build.value = item.folder;
                  renderBuildSelection();
                  updateControls();
                },
              },
            },
            h("span", { class: "file-mark", "aria-hidden": "true" }, "</>"),
            stack(
              h("strong", {}, item.folder),
              p(
                `index.html · ${new Date(item.modifiedAt).toLocaleDateString(host.locale)}`,
                "muted",
              ),
            ),
            h("span", { class: "choice-state", "aria-hidden": "true" }, "✓"),
          ),
        )
      : [h("omg-empty", { heading: t.noBuild, description: t.noBuildHint })]),
  );
  if (!build.value) {
    const remembered = state.status?.prepared?.buildFolder;
    const suggested = candidates.filter((item) => item.suggested);
    if (remembered && candidates.some((item) => item.folder === remembered))
      build.value = remembered;
    else if (suggested.length === 1) build.value = suggested[0].folder;
    else if (candidates.length === 1) build.value = candidates[0].folder;
  }
  if (state.workspace.truncated) buildChoices.append(p(t.truncated, "muted"));
  if (!candidates.length) manualFolder.open = true;
  renderBuildSelection();
}
function renderBuildSelection() {
  for (const node of buildChoices.querySelectorAll("button"))
    node.setAttribute(
      "aria-pressed",
      String(node.dataset.folder === build.value),
    );
}
function jobsForGame() {
  return (state.status?.uploads ?? [])
    .filter(
      (job) =>
        job.target.appId === state.selected?.appId &&
        job.target.developerId === state.selected?.developerId,
    )
    .slice()
    .reverse();
}
function renderUploads() {
  const jobs = jobsForGame();
  uploadView.replaceChildren(
    ...(jobs.length
      ? jobs.map((job) =>
          h(
            "article",
            { class: "upload-record" },
            row(
              note(
                state.overview?.packages?.data?.package_slots?.main?.expected
                  ?.kind === "h5" &&
                  state.overview.packages.data.package_slots.main.expected
                    .h5_version_id === String(job.receipt?.h5VersionId)
                  ? t.bound
                  : t[job.state] || t.unknown,
                ["unknown", "failed"].includes(job.state)
                  ? "warning"
                  : job.state === "ready"
                    ? "good"
                    : "neutral",
              ),
              p(new Date(job.startedAt).toLocaleString(host.locale), "muted"),
            ),
            job.state === "uploading"
              ? h("omg-progress", { label: t.uploading })
              : undefined,
            job.error
              ? h("omg-banner", { tone: "warning" }, job.error)
              : undefined,
            row(
              button(
                t.check,
                async () => {
                  await request("reconcile", { uploadId: job.id });
                  await refreshStatus();
                  await loadOverview();
                },
                { variant: "ghost", disabled: job.state === "uploading" },
              ),
              ["unknown", "failed"].includes(job.state)
                ? button(
                    t.fix,
                    () =>
                      agent(
                        `Reconcile the existing upload intent ${job.id}, receipt ${JSON.stringify(job.receipt || {})}, without uploading again. Do not submit review.`,
                      ),
                    { variant: "ghost" },
                  )
                : undefined,
            ),
          ),
        )
      : [p(t.emptyUpload, "muted")]),
  );
  const prepared = state.status?.prepared;
  preparedView.replaceChildren(
    ...(prepared && !jobs.some((job) => job.id === prepared.id)
      ? [
          note(
            `${t.prepared} · ${(prepared.bytes / 1024 / 1024).toFixed(2)} MB`,
            "good",
          ),
          ...prepared.warnings.map((text) =>
            h("omg-banner", { tone: "warning" }, text),
          ),
        ]
      : []),
  );
}
const moduleNames = {
  "basic-info": t.basic,
  "assets-upload": t.assets,
  "developer-info": t.author,
  "platform-status": t.platforms,
  "release-settings": t.schedule,
};
const editableFields = {
  "basic-info": [
    "title",
    "description",
    "category",
    "promotion_text",
    "title_ios",
    "description_ios",
    "icon",
    "icon_ios",
  ],
  "developer-info": ["developer_message"],
  "assets-upload": [
    "banner_4",
    "square_promo_image",
    "screenshots",
    "banner_4_ios",
    "square_promo_image_ios",
    "screenshots_ios",
  ],
};
const moduleNav = h("nav", { class: "module-nav", "aria-label": t.module });
const moduleView = h("div", { class: "fields" });
const previewView = h("aside", {
  class: "store-preview",
  "aria-label": t.preview,
});
const dirtyStatus = p(t.nothingChanged, "muted");
const saveButton = button(t.save, saveFields, { variant: "primary" });
const discardButton = button(
  t.discard,
  async () => {
    if (
      !(await host.request("ui.confirm", {
        title: t.discardConfirm,
        message: moduleNames[state.moduleId],
        confirmLabel: t.discardAction,
      }))
    )
      return;
    delete state.edits[state.moduleId];
    await persistEdits();
    renderModule();
    renderPreview();
    updateControls();
  },
  { variant: "ghost" },
);
let storageQueue = Promise.resolve();
function persistEdits() {
  if (!state.selected) return storageQueue;
  const key = `draft-${state.selected.developerId}-${state.selected.appId}`;
  const value = JSON.parse(JSON.stringify(state.edits));
  storageQueue = storageQueue
    .catch(() => {})
    .then(() => host.request("storage.set", { key, value }));
  return storageQueue;
}
async function restoreEdits() {
  if (!state.selected) return;
  const saved = await host.request("storage.get", {
    key: `draft-${state.selected.developerId}-${state.selected.appId}`,
  });
  if (saved && typeof saved === "object" && !Array.isArray(saved))
    state.edits = saved;
}
function edits() {
  return state.edits[state.moduleId] || {};
}
function currentValue(moduleId, field) {
  return state.edits[moduleId]?.[field.field_id]?.value ?? field.current_value;
}
function editField(field, value) {
  const changes = (state.edits[state.moduleId] ??= {});
  const expected = Object.hasOwn(changes, field.field_id)
    ? changes[field.field_id].expected
    : (field.current_value ?? null);
  if (JSON.stringify(value) === JSON.stringify(expected))
    delete changes[field.field_id];
  else changes[field.field_id] = { expected, value };
  void persistEdits().catch((error) =>
    errorBox.replaceChildren(h("omg-banner", { tone: "bad" }, error.message)),
  );
  renderPreview();
  updateControls();
}
function imageView(value, label, attrs = {}) {
  const view = h("omg-image", { alt: label, fit: "cover", ...attrs });
  if (!value?.url) return view;
  let pending = state.imageCache.get(value.url);
  if (!pending) {
    pending = request("image", { url: value.url });
    state.imageCache.set(value.url, pending);
  }
  void pending.then(
    (result) => view.setAttribute("src", result.src),
    () => {
      state.imageCache.delete(value.url);
      view.setAttribute("alt", `${label} · ${t.imageFailed}`);
      view.setAttribute("title", t.imageFailed);
    },
  );
  return view;
}
function imageSpec(field) {
  const spec = field.image_spec;
  if (!spec) return "";
  return [
    spec.aspect_ratio,
    spec.min_width && spec.min_height
      ? `≥ ${spec.min_width} × ${spec.min_height}`
      : "",
    spec.formats?.join(" / "),
    spec.content_note,
  ]
    .filter(Boolean)
    .join(" · ");
}
function imageField(field, mutable) {
  const value = currentValue(state.moduleId, field);
  const images = (Array.isArray(value) ? value : [value]).filter(Boolean);
  const gallery = h("div", {
    class: field.input_type === "image_array" ? "image-strip" : "image-single",
  });
  gallery.append(
    ...images.map((image, index) =>
      stack(
        imageView(image, `${field.label} ${index + 1}`, {
          ratio: field.image_spec?.aspect_ratio?.replace(":", "/") || "16/9",
        }),
        mutable && field.input_type === "image_array"
          ? button(
              t.removeImage,
              async () => {
                editField(
                  field,
                  images.filter((_, i) => i !== index),
                );
                renderModule();
              },
              { variant: "ghost" },
            )
          : undefined,
      ),
    ),
  );
  if (!mutable) return stack(gallery, p(imageSpec(field), "muted spec"));
  const pickerGrid = h("div", { class: "project-image-grid" });
  const pickerError = h("div", { role: "alert" });
  const pickerStatus = h(
    "omg-status",
    { hidden: true, tone: "busy" },
    t.working,
  );
  const localPicker = h("omg-file-picker", {
    label: t.localImage,
    accept: ".png,.jpg,.jpeg,.webp",
    "choose-label": t.chooseFile,
    "drop-label": t.dropImage,
    "clear-label": t.clearFile,
    "rejected-label": t.imageFileError,
    hint: t.imageImportHint,
  });
  const picker = h("omg-dialog", {
    heading: field.label,
    description: `${state.selected.title} · ${imageSpec(field)}`,
    "close-label": t.close,
  });
  let imported;
  const errorTarget = () => (picker.open ? pickerError : errorBox);
  const uploadImage = async (item) => {
    const file = item ? undefined : localPicker.files[0];
    if (!item && !file) return;
    if (
      file &&
      (file.size > 20 * 1024 * 1024 || !/\.(png|jpe?g|webp)$/i.test(file.name))
    ) {
      localPicker.setAttribute("error", t.imageFileError);
      return;
    }
    if (
      !(await host.request("ui.confirm", {
        title: t.imageConfirm,
        message: `${state.selected.title}\n${item?.path || file.name}\n${field.label}: ${imageSpec(field)}`,
        confirmLabel: t.imageUpload,
      }))
    )
      return;
    pickerStatus.hidden = false;
    try {
      let path = item?.path;
      if (file) {
        if (!imported || imported.file !== file) {
          const extension = file.name.match(/\.[^.]+$/)[0].toLowerCase();
          const destination = `taptap-materials/${crypto.randomUUID()}${extension}`;
          await host.request("files.write", { path: destination, data: file });
          imported = { file, path: destination };
        }
        path = imported.path;
      }
      const uploaded = await request("upload-image", {
        appId: state.selected.appId,
        file: path,
      });
      editField(
        field,
        field.input_type === "image_array" ? [...images, uploaded] : uploaded,
      );
      picker.open = false;
      renderModule();
      feedback.replaceChildren(note(t.imagePending, "good"));
    } finally {
      pickerStatus.hidden = true;
    }
  };
  const uploadLocal = h(
    "omg-button",
    {
      variant: "primary",
      disabled: true,
      "data-fixed-disabled": "true",
      on: { click: () => void act(() => uploadImage(), errorTarget) },
    },
    t.imageUpload,
  );
  localPicker.addEventListener("change", () => {
    if (imported?.file !== localPicker.files[0]) imported = undefined;
    localPicker.removeAttribute("error");
    uploadLocal.dataset.fixedDisabled = String(!localPicker.files.length);
    updateControls();
  });
  picker.append(
    stack(
      pickerError,
      pickerStatus,
      localPicker,
      row(uploadLocal),
      h("h3", {}, t.projectImages),
      pickerGrid,
    ),
  );
  const openPicker = h(
    "omg-button",
    {
      variant: "ghost",
      on: {
        click: () => {
          if (!pickerGrid.childElementCount)
            pickerGrid.append(
              ...(state.workspace?.images?.length
                ? state.workspace.images.map((item) =>
                    h("omg-tile", {
                      heading: item.name,
                      file: item.path,
                      alt: item.name,
                      fit: "contain",
                      ratio: "4/3",
                      on: {
                        click: () =>
                          void act(() => uploadImage(item), errorTarget),
                      },
                    }),
                  )
                : [p(t.noImages, "muted")]),
            );
          picker.open = true;
        },
      },
    },
    images.length && field.input_type !== "image_array"
      ? t.replaceImage
      : t.chooseImage,
  );

  return stack(
    gallery,
    p(imageSpec(field), "muted spec"),
    row(openPicker),
    picker,
  );
}
function renderModule() {
  moduleNav.replaceChildren(
    ...Object.entries(moduleNames).map(([id, label]) =>
      button(
        label,
        async () => {
          await loadModule(id);
        },
        {
          variant: "ghost",
          "aria-current": state.moduleId === id ? "page" : undefined,
        },
      ),
    ),
  );
  const value = state.modules[state.moduleId];
  if (!value) return;
  const main = [],
    ios = [];
  const fieldOrder = [
    "title",
    "category",
    "description",
    "promotion_text",
    "icon",
    "banner_4",
    "square_promo_image",
    "screenshots",
  ];
  const fields = Object.values(value.fields).sort(
    (a, b) =>
      (fieldOrder.includes(a.field_id) ? fieldOrder.indexOf(a.field_id) : 100) -
      (fieldOrder.includes(b.field_id) ? fieldOrder.indexOf(b.field_id) : 100),
  );
  for (const field of fields) {
    const mutable =
      editableFields[state.moduleId]?.includes(field.field_id) &&
      field.state !== "readonly";
    const current = currentValue(state.moduleId, field);
    let control;
    if (["image", "image_array"].includes(field.input_type))
      control = stack(h("h3", {}, field.label), imageField(field, mutable));
    else if (
      mutable &&
      ["text", "textarea", "select"].includes(field.input_type)
    ) {
      control = h(
        field.input_type === "select"
          ? "omg-select"
          : field.input_type === "textarea"
            ? "omg-textarea"
            : "omg-input",
        {
          label: `${field.label}${field.state === "required" ? " *" : ""}`,
          value: current ?? "",
          rows: field.input_type === "textarea" ? "6" : undefined,
          hint: field.hint,
          on: {
            input: (event) => editField(field, event.currentTarget.value),
            change: (event) => editField(field, event.currentTarget.value),
          },
        },
        ...(field.input_type === "select"
          ? (field.options || []).map((option) =>
              h(
                "option",
                { value: option },
                field.value_labels?.[option] || option,
              ),
            )
          : []),
      );
    } else {
      let text = field.value_labels?.[String(current)] ?? current;
      if (Array.isArray(current))
        text = current
          .map((item) => field.value_labels?.[String(item)] || String(item))
          .join(" · ");
      else if (current && typeof current === "object")
        text =
          current.kind === "immediate"
            ? t.immediate
            : current.kind === "scheduled_exact"
              ? new Date(current.release_time * 1000).toLocaleString(
                  host.locale,
                )
              : t.mediaReady;
      control = stack(
        h("h3", {}, field.label),
        p(String(text ?? t.unfilled), "value"),
      );
    }
    const change = edits()[field.field_id];
    const conflict =
      change &&
      JSON.stringify(change.expected) !==
        JSON.stringify(field.current_value ?? null);
    const wrapped = h(
      "div",
      {
        class: `field ${["title", "category"].includes(field.field_id) ? "short-field" : ""} ${field.input_type === "image" ? "image-field" : ""}`,
      },
      control,
      field.validation_error
        ? p(field.validation_error, "field-error")
        : undefined,
      conflict ? p(t.refreshConflict, "field-error") : undefined,
    );
    (field.field_id.endsWith("_ios") ? ios : main).push(wrapped);
  }
  moduleView.replaceChildren(
    ...main,
    ...(ios.length
      ? [
          h(
            "omg-disclosure",
            { class: "ios-fields", heading: t.iosOverrides },
            stack(...ios),
          ),
        ]
      : []),
  );
  renderPreview();
}
async function loadModule(moduleId = state.moduleId) {
  if (!state.selected) return;
  const value = await request("module", { moduleId });
  state.moduleId = moduleId;
  state.modules[moduleId] = value;
  renderModule();
}
async function saveFields() {
  const changes = Object.entries(edits()).map(([fieldId, value]) => ({
    fieldId,
    ...value,
  }));
  if (!changes.length) return;
  const value = await request("save-fields", {
    appId: state.selected.appId,
    moduleId: state.moduleId,
    changes,
  });
  for (const fieldId of value.saved) delete edits()[fieldId];
  state.modules[state.moduleId] = value.module;
  if (value.saved.includes("title")) {
    state.selected.title = value.module.fields.title.current_value;
    title.textContent = state.selected.title;
  }
  await persistEdits();
  renderModule();
  feedback.replaceChildren(
    note(
      value.unresolved.length ? t.partialSave : t.saved,
      value.unresolved.length ? "warning" : "good",
    ),
  );
  if (value.error)
    errorBox.replaceChildren(h("omg-banner", { tone: "warning" }, value.error));
  await loadOverview();
}
function renderPreview() {
  const basic = state.modules["basic-info"]?.fields;
  if (!basic) {
    previewView.replaceChildren(p(t.preview, "muted"));
    return;
  }
  const value = (id, moduleId = "basic-info") => {
    const field = state.modules[moduleId]?.fields?.[id];
    return field ? currentValue(moduleId, field) : undefined;
  };
  const icon = value("icon"),
    banner = value("banner_4", "assets-upload");
  const screenshots = value("screenshots", "assets-upload") || [];
  previewView.replaceChildren(
    p(t.preview, "eyebrow"),
    h(
      "div",
      { class: "preview-sheet" },
      banner
        ? imageView(banner, t.assets, {
            ratio: "16/9",
            class: "preview-banner",
          })
        : undefined,
      h(
        "div",
        { class: "preview-body" },
        row(
          icon
            ? imageView(icon, t.basic, { ratio: "1/1", class: "preview-icon" })
            : undefined,
          stack(
            h("h2", {}, value("title") || state.selected.title),
            p(
              basic.category?.value_labels?.[value("category")] ||
                value("category") ||
                "H5",
              "muted",
            ),
          ),
        ),
        p(value("description") || t.noDescription, "preview-description"),
        screenshots.length
          ? h(
              "div",
              { class: "preview-screenshots" },
              ...screenshots.map((item, i) =>
                imageView(item, `${t.assets} ${i + 1}`, { ratio: "9/16" }),
              ),
            )
          : undefined,
      ),
    ),
    p(t.draftOnly, "muted"),
  );
}
const packageActions = new Map();
const packageTable = h("omg-table", {
  label: t.remotePackages,
  "empty-label": t.emptyUpload,
});
packageTable.columns = [
  { key: "version", heading: t.tableVersion },
  { key: "status", heading: t.tableStatus },
  { key: "action", heading: t.tableAction, align: "right" },
];
const versionTable = h("omg-table", {
  label: t.releases,
  "empty-label": t.noVersions,
});
versionTable.columns = [
  { key: "version", heading: t.tableVersion },
  { key: "date", heading: t.tableDate },
  { key: "status", heading: t.tableStatus },
];
const versionsView = h("div", { class: "stack" });
const issuesView = h("div", { class: "stack" });
const versionPagination = h("omg-pagination", {
  label: t.releases,
  "previous-label": t.previous,
  "next-label": t.next,
  on: {
    "omg-page-change": (event) =>
      void act(() => loadOverview(event.detail.page)),
  },
});
async function bind(item, packages) {
  if (
    !(await host.request("ui.confirm", {
      title: t.bindConfirm,
      message: `${state.selected.title}\n${item.version_name || item.package_id}\n${t.bindHint}`,
      confirmLabel: t.bind,
    }))
  )
    return;
  await request("bind", {
    appId: state.selected.appId,
    packageId: item.package_id,
    expected: packages.package_slots.main.expected,
  });
  feedback.replaceChildren(note(t.boundSuccess, "good"));
  await loadOverview();
}
async function loadOverview(page = state.versionPage) {
  if (!state.selected) return;
  const overview = await request("overview", { page });
  // A partial overview failure must not advance the displayed versions page.
  if (overview.versions?.error && page !== state.versionPage)
    throw new Error(overview.versions.error);
  state.versionPage = page;
  state.overview = overview;
  if (state.versionPage === 1) state.currentVersions = state.overview.versions;
  renderOverview();
  renderUploads();
}
function renderOverview() {
  const overview = state.overview;
  if (!overview) return;
  const packages = overview.packages?.data;
  const slot = packages?.package_slots?.main;
  const current = packages?.list?.find(
    (item) =>
      item.type === "h5" &&
      slot?.expected?.kind === "h5" &&
      slot.expected.h5_version_id === item.package_id,
  );
  const versions = overview.versions?.data;
  const draft = state.currentVersions?.data?.list?.find(
    (item) => item.status === "draft",
  );
  const analysis = overview.analysis?.data;
  const count = new Set(
    analysis?.blockers?.flatMap((item) => item.field_ids || []),
  ).size;
  summary.replaceChildren(
    ...[
      [t.draftVersion, draft?.version || (versions ? t.noDraft : t.loading)],
      [
        t.currentPackage,
        current?.version_name ||
          (slot?.expected?.kind === "h5"
            ? slot.expected.h5_version_id
            : t.notBound),
      ],
      [
        t.requirements,
        analysis
          ? analysis.blockers?.length
            ? `${count || analysis.blockers.length} ${t.missingFields}`
            : t.allFilled
          : t.readinessUnknown,
      ],
    ].map(([label, value]) => stack(p(label, "muted"), h("strong", {}, value))),
  );
  const packageRows =
    packages?.list?.filter((item) => item.type === "h5") || [];
  if (overview.packages?.error)
    libraryView.replaceChildren(
      h("omg-banner", { tone: "warning" }, overview.packages.error),
    );
  else {
    if (packageTable.parentNode !== libraryView)
      libraryView.replaceChildren(packageTable);
    const keys = new Set(packageRows.map((item) => String(item.package_id)));
    for (const key of packageActions.keys())
      if (!keys.has(key)) packageActions.delete(key);
    packageTable.rows = packageRows.map((item) => {
      const key = String(item.package_id);
      let action = packageActions.get(key);
      if (!action) {
        action = button("", () => {
          const latest = state.overview.packages.data;
          return bind(
            latest.list.find(
              (candidate) => String(candidate.package_id) === key,
            ),
            latest,
          );
        });
        packageActions.set(key, action);
      }
      const disabled =
        current === item ||
        item.status !== "ready" ||
        !slot?.available ||
        !slot.expected ||
        !draft;
      action.textContent = current === item ? t.current : t.bind;
      action.setAttribute("variant", current === item ? "ghost" : "secondary");
      action.dataset.fixedDisabled = String(disabled);
      action.disabled = state.busy || disabled;
      return {
        key,
        cells: {
          version: item.version_name || item.package_id,
          status: current === item ? t.bound : t[item.status] || item.status,
          action,
        },
      };
    });
  }
  if (overview.versions?.error)
    versionsView.replaceChildren(
      h("omg-banner", { tone: "warning" }, overview.versions.error),
    );
  else {
    if (versionTable.parentNode !== versionsView)
      versionsView.replaceChildren(versionTable);
    versionTable.rows = (versions?.list || []).map((item) => ({
      key: String(item.id || item.version),
      cells: {
        version: item.version,
        date: item.created_time
          ? new Date(item.created_time * 1000).toLocaleDateString(host.locale)
          : "—",
        status: item.status_reason
          ? `${t[item.status] || item.status_label || item.status} · ${item.status_reason}`
          : t[item.status] || item.status_label || item.status,
      },
    }));
  }
  issuesView.replaceChildren(
    ...(analysis
      ? [
          ...(analysis.blockers || []).map((item) =>
            h("omg-banner", { tone: "warning" }, item.message),
          ),
          ...(analysis.warnings || []).map((item) => p(item.message, "muted")),
        ]
      : [p(overview.analysis?.error || t.unknownIssues, "muted")]),
  );
  versionPagination.hidden = !versions || versions.total <= versions.page_size;
  versionPagination.setAttribute("page", String(state.versionPage));
  versionPagination.setAttribute(
    "pages",
    String(
      versions
        ? Math.max(1, Math.ceil(versions.total / versions.page_size))
        : 1,
    ),
  );
}
async function loadCapabilities() {
  try {
    state.capabilities = await request("capabilities");
    const allowed = state.capabilities.available_package_types?.includes("h5");
    capabilityView.replaceChildren(
      allowed
        ? note(t.available, "good")
        : h(
            "omg-banner",
            { tone: "warning" },
            state.capabilities.empty_reason === "declared_not_applicable"
              ? t.conflict
              : t.unavailable,
          ),
    );
  } catch (error) {
    state.capabilities = undefined;
    capabilityView.replaceChildren(
      h(
        "omg-banner",
        { tone: "warning", heading: t.unknownAvailability },
        error.message,
      ),
    );
  }
}
async function refreshStatus() {
  const initial = !state.status;
  state.status = await request("status");
  if (initial && state.status.prepared) {
    build.value = state.status.prepared.buildFolder || "";
    orientation.value = String(state.status.prepared.orientation);
  }
  state.selected = state.status.selection;
  title.textContent = state.selected?.title || "TapTap";
  identity.textContent = state.selected
    ? `TapTap · ${state.selected.appId}`
    : t.noSelection;
  connectionStatus.replaceChildren(
    state.status.cli.error
      ? h("omg-banner", { tone: "warning" }, state.status.cli.error)
      : note(
          `${state.status.cli.signedIn ? t.signedIn : t.signedOut} · CLI ${state.status.cli.version}`,
          state.status.cli.signedIn ? "good" : "warning",
        ),
  );
  workspaceView.hidden = !state.selected;
  account.setAttribute(
    "label",
    state.status.cli.error
      ? t.missing
      : !state.status.cli.signedIn
        ? t.signedOut
        : t.account,
  );
  renderUploads();
}
async function refreshData() {
  if (!state.selected) return;
  await Promise.all([
    loadCapabilities(),
    loadOverview(),
    loadModule(),
    discover(),
  ]);
  if (!state.modules["basic-info"])
    state.modules["basic-info"] = await request("module", {
      moduleId: "basic-info",
    });
  renderPreview();
}
async function refresh() {
  await refreshStatus();
  if (state.status.cli.error || !state.status.cli.signedIn) return;
  await refreshData();
  if (!state.selected) {
    chooser.open = true;
    await loadDevelopers();
  }
}
function updateControls() {
  for (const node of root.querySelectorAll(controls))
    node.toggleAttribute(
      "disabled",
      state.busy || node.dataset.fixedDisabled === "true",
    );
  for (const node of buildChoices.querySelectorAll("button"))
    node.disabled = state.busy;
  const pending = state.status?.uploads?.some((job) =>
    ["unknown", "uploading"].includes(job.state),
  );
  uploadButton.disabled =
    state.busy ||
    !state.selected ||
    !build.value?.trim() ||
    !state.capabilities?.available_package_types?.includes("h5") ||
    pending;
  const dirty = Object.keys(edits()).length;
  dirtyStatus.textContent = dirty
    ? `${t.unsaved} · ${dirty}`
    : t.nothingChanged;
  saveButton.disabled = state.busy || !dirty || !state.selected;
  discardButton.disabled = state.busy || !dirty;
}
const uploadTab = h(
  "omg-tab",
  { name: "upload", heading: t.upload },
  h(
    "div",
    { class: "workspace-grid" },
    stack(
      h(
        "section",
        { class: "build-section" },
        h(
          "div",
          { class: "section-header" },
          h("h2", {}, t.source),
          button(t.rescan, discover, { variant: "ghost" }),
        ),
        p(t.uploadHint, "muted"),
        buildChoices,
        manualFolder,
        h(
          "div",
          { class: "upload-actions" },
          orientation,
          row(buildAgent, uploadButton),
        ),
        preparedView,
      ),
      h("section", {}, h("h2", {}, t.recentUploads), uploadView),
    ),
    stack(
      h("section", {}, h("h2", {}, t.remotePackages), libraryView),
      capabilityView,
    ),
  ),
);
const detailsTab = h(
  "omg-tab",
  { name: "details", heading: t.details },
  moduleNav,
  h(
    "div",
    { class: "workspace-grid details-grid" },
    h(
      "div",
      {},
      moduleView,
      h(
        "div",
        { class: "save-bar" },
        dirtyStatus,
        row(discardButton, saveButton),
      ),
    ),
    previewView,
  ),
);
const versionsTab = h(
  "omg-tab",
  { name: "releases", heading: t.releases },
  h(
    "div",
    { class: "workspace-grid" },
    stack(versionsView, versionPagination),
    stack(
      h("h2", {}, t.issues),
      issuesView,
      button(t.openConsole, openConsole),
    ),
  ),
);
const tabs = h(
  "omg-tabs",
  { value: "upload" },
  uploadTab,
  detailsTab,
  versionsTab,
);
const workspaceView = stack(summary, tabs);
root.append(
  topbar,
  h("div", { class: "connection-row" }, chooser),
  errorBox,
  activity,
  feedback,
  workspaceView,
);
host.on("visibility", ({ visible }) => {
  state.visible = visible;
  if (visible && !state.busy) void act(refreshStatus);
});
// Reads stop when hidden. Native ownership and persisted drafts outlive the view.
setInterval(() => {
  if (
    state.visible &&
    !state.busy &&
    state.status?.uploads?.some((job) => job.state === "uploading")
  )
    void act(refreshStatus);
}, 5000);
await act(async () => {
  await refreshStatus();
  await restoreEdits();
  if (state.status.cli.signedIn) {
    await refreshData();
    if (!state.selected) {
      chooser.open = true;
      await loadDevelopers();
    }
  }
});
