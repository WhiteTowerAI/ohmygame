export const PLUGIN_ICON_PRESETS = [
  { id: "package", label: "Package", keywords: "plugin 插件" },
  { id: "gamepad", label: "Game", keywords: "play 游戏" },
  { id: "globe", label: "Web", keywords: "internet network 网络 网页" },
  { id: "box", label: "3D", keywords: "model world 模型 世界" },
  { id: "image", label: "Image", keywords: "sprite photo 图片 精灵" },
  { id: "palette", label: "Design", keywords: "color art 设计 颜色" },
  { id: "brush", label: "Paint", keywords: "draw texture 绘画 纹理" },
  { id: "music", label: "Music", keywords: "audio sound 音乐 音效" },
  { id: "video", label: "Video", keywords: "movie 视频" },
  { id: "film", label: "Animation", keywords: "cinema 动画" },
  { id: "code", label: "Code", keywords: "program script 代码 脚本" },
  { id: "terminal", label: "Terminal", keywords: "command shell 命令" },
  { id: "plug", label: "Connection", keywords: "mcp service 连接 服务" },
  { id: "server", label: "Server", keywords: "api backend 服务器" },
  { id: "wand", label: "Magic", keywords: "generate automation 生成 自动化" },
  { id: "sparkles", label: "AI", keywords: "assistant 智能 助手" },
  { id: "document", label: "Document", keywords: "text story 文档 故事" },
  { id: "folder", label: "Files", keywords: "assets 文件 资源" },
  { id: "layers", label: "Layers", keywords: "scene level 图层 场景 关卡" },
  { id: "lightbulb", label: "Ideas", keywords: "planning 创意 规划" },
  { id: "search", label: "Search", keywords: "find research 搜索 研究" },
  { id: "wrench", label: "Tools", keywords: "repair utility 工具 修复" },
  { id: "clipboard", label: "Review", keywords: "check qa 检查 评审" },
  { id: "flag", label: "Goals", keywords: "quest task 目标 任务" },
] as const;

export type PluginIconPresetId = (typeof PLUGIN_ICON_PRESETS)[number]["id"];
export const PLUGIN_ICON_MAX_BYTES = 1024 * 1024;
export const PLUGIN_ICON_MAX_DIMENSION = 2048;
