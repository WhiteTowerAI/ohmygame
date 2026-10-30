import { Bot, Globe2, InfoCircle, Key, Palette as PaletteIcon, Server, Settings, UserRound, Wifi } from "./icons.js";
import type { SettingsSection } from "./routes.js";
import { t } from "./i18n.js";

// Sections in groups, as in the lab: the app itself, AI, what other tools
// connect through, then the account. Billing stays hidden until it ships;
// its page still answers its link.
export const SETTINGS_NAV: Array<{ heading?: string; items: Array<{ section: SettingsSection; label: string; icon: typeof Settings }> }> = [
  { items: [
    { section: "general", label: t("settings.nav.general"), icon: Settings },
    { section: "appearance", label: t("settings.nav.appearance"), icon: PaletteIcon },
  ] },
  { heading: t("settings.nav.ai"), items: [
    { section: "agents", label: t("settings.nav.agents"), icon: Bot },
    { section: "providers", label: t("settings.nav.providers"), icon: Key },
    { section: "web-search", label: t("settings.nav.webSearch"), icon: Globe2 },
  ] },
  { heading: t("settings.nav.connections"), items: [
    { section: "mcp-server", label: t("settings.nav.mcpServer"), icon: Server },
    { section: "network", label: t("settings.nav.network"), icon: Wifi },
  ] },
  { heading: t("settings.nav.accountGroup"), items: [
    { section: "account", label: t("settings.nav.account"), icon: UserRound },
    { section: "about", label: t("settings.nav.about"), icon: InfoCircle },
  ] },
];
