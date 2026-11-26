import { createRoot } from "react-dom/client";
import { init as initSentry } from "@sentry/electron/renderer";
import { App } from "./app.js";
import { AuthProvider } from "./auth.js";
import { projectHash } from "./routes.js";
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
await initializeUsageData(true);
if (window.ohMyGameDesktop) initSentry();
applyAppearance(readAppearance(), { desktop: true });
applyPalette(readPalette());
applyPluginTheme(readPluginTheme());
applyChatFont(readChatFont());
sendNotificationPreferences();
sendApplicationMenuLabels();
await initializeRuntimeConnection({ followService: true });
applyAutoUpdate();
if (window.ohMyGameDesktop?.platform === "darwin") {
  document.documentElement.classList.add("desktop-macos");
}
const content = (
  <ErrorBoundary
    label={t("errorBoundary.label.application")}
    onHome={() => { window.location.hash = "#/projects"; }}
  >
    <AuthProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </AuthProvider>
  </ErrorBoundary>
);
createRoot(root).render(
  <DesktopCloseGuard>
    <RuntimeNotice />
    <DesktopWindowFrame>{content}</DesktopWindowFrame>
  </DesktopCloseGuard>,
);
// Analytics waits until the first frame is up.
requestIdleCallback(initializeAnalytics, { timeout: 2_000 });
