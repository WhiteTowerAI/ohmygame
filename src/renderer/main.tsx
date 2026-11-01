import { createRoot } from "react-dom/client";
import { init as initSentry } from "@sentry/electron/renderer";
import { App } from "./app.js";
import { AuthProvider } from "./auth.js";
import { PlaytestPage } from "./playtest.js";
import { NodeThumbnailPage } from "./node-thumbnail-page.js";
import { parseAppRoute, projectHash } from "./routes.js";
import { applyAutoUpdate, launchProject } from "./general-preferences.js";
import { applyAppearance, applyChatFont, applyPalette, readAppearance, readChatFont, readPalette } from "./appearance.js";
import { DesktopWindowFrame } from "./desktop-window-frame.js";
import { initializeAnalytics } from "./analytics.js";
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
if (window.ohMyGameDesktop) initSentry();
// A hidden thumbnail window runs Scene code, so the desktop app lets it only
// capture and report; it themes and connects without asking the app.
const thumbnail = route.page === "thumbnail";
applyAppearance(readAppearance(), { desktop: !thumbnail });
applyPalette(readPalette());
applyChatFont(readChatFont());
await initializeRuntimeConnection({ followService: !thumbnail });
if (route.page !== "thumbnail" && route.page !== "playtest") applyAutoUpdate();
if (window.ohMyGameDesktop?.platform === "darwin") {
  document.documentElement.classList.add("desktop-macos");
}
const content = (
  <>
    <RuntimeNotice />
    <ErrorBoundary
      label={t("errorBoundary.label.application")}
      onHome={
        route.page === "playtest" || route.page === "thumbnail"
          ? undefined
          : () => {
              window.location.hash = "#/projects";
            }
      }
    >
      {route.page === "playtest" ? (
        <PlaytestPage projectId={route.projectId} />
      ) : route.page === "thumbnail" ? (
        <NodeThumbnailPage projectId={route.projectId} nodeId={route.nodeId} />
      ) : (
        <DesktopWindowFrame>
          <AuthProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </AuthProvider>
        </DesktopWindowFrame>
      )}
    </ErrorBoundary>
  </>
);
createRoot(root).render(
  route.page === "playtest" || route.page === "thumbnail" ? (
    content
  ) : (
    <DesktopCloseGuard>{content}</DesktopCloseGuard>
  ),
);
// The hidden thumbnail window is not a visit. Analytics waits until the first frame is up.
if (route.page !== "thumbnail") requestIdleCallback(initializeAnalytics, { timeout: 2_000 });
