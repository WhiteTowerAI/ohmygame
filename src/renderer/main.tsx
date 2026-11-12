import { createRoot } from "react-dom/client";
import { init as initSentry } from "@sentry/electron/renderer";
import { App } from "./app.js";
import { AuthProvider } from "./auth.js";
import { PlaytestPage } from "./playtest.js";
import { NodeThumbnailPage } from "./node-thumbnail-page.js";
import { parseAppRoute, projectHash } from "./routes.js";
import { applyAutoUpdate, launchProject } from "./general-preferences.js";
import { applyAppearance, applyChatFont, applyPalette, applyPluginTheme, readAppearance, readChatFont, readPalette, readPluginTheme } from "./appearance.js";
import { sendNotificationPreferences } from "./agent-notifications.js";
import { DesktopWindowFrame, sendApplicationMenuLabels } from "./desktop-window-frame.js";
import { initializeAnalytics, initializeUsageData } from "./analytics.js";
import { initializeRuntimeConnection } from "./runtime-connection.js";
import { RuntimeNotice } from "./runtime-notice.js";
import { ErrorBoundary } from "./error-boundary.js";
import { ToastProvider } from "./ui/index.js";
import { DesktopCloseGuard } from "./desktop-close-guard.js";
import "./styles.css";
import "./runtime-recovery.css";
import { t } from "./i18n.js";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root was not found");
// Settings → General → Open to: a launch on Home goes to the last project instead.
const reopen = !window.location.hash || window.location.hash === "#/" ? launchProject() : undefined;
if (reopen) window.history.replaceState(window.history.state, "", projectHash(reopen));
const route = parseAppRoute(window.location.hash);
// A hidden thumbnail window runs Scene code, so the desktop app lets it only
// capture and report; it themes and connects without asking the app.
const thumbnail = route.page === "thumbnail";
const mainRoute = !thumbnail && route.page !== "playtest";
if (mainRoute) await initializeUsageData();
if (window.ohMyGameDesktop) initSentry();
applyAppearance(readAppearance(), { desktop: !thumbnail });
applyPalette(readPalette());
applyPluginTheme(readPluginTheme());
applyChatFont(readChatFont());
// Only the main window shows the conversations that notifications are about.
if (mainRoute) {
  sendNotificationPreferences();
  sendApplicationMenuLabels();
}
await initializeRuntimeConnection({ followService: !thumbnail });
if (mainRoute) applyAutoUpdate();
if (window.ohMyGameDesktop?.platform === "darwin") {
  document.documentElement.classList.add("desktop-macos");
}
const content = (
  <ErrorBoundary
    label={t("errorBoundary.label.application")}
    onHome={mainRoute ? () => { window.location.hash = "#/projects"; } : undefined}
  >
    {route.page === "playtest" ? (
      <PlaytestPage projectId={route.projectId} />
    ) : route.page === "thumbnail" ? (
      <NodeThumbnailPage projectId={route.projectId} nodeId={route.nodeId} />
    ) : (
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    )}
  </ErrorBoundary>
);
createRoot(root).render(mainRoute ? (
  <DesktopCloseGuard>
    <RuntimeNotice />
    <DesktopWindowFrame>{content}</DesktopWindowFrame>
  </DesktopCloseGuard>
) : <><RuntimeNotice />{content}</>);
// The hidden thumbnail window is not a visit. Analytics waits until the first frame is up.
if (route.page !== "thumbnail") requestIdleCallback(initializeAnalytics, { timeout: 2_000 });
