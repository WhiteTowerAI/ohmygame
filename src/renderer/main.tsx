import { createRoot } from "react-dom/client";
import { init as initSentry } from "@sentry/electron/renderer";
import { App } from "./app.js";
import { AuthProvider } from "./auth.js";
import { PlaytestPage } from "./playtest.js";
import { NodeThumbnailPage } from "./node-thumbnail-page.js";
import { parseAppRoute } from "./routes.js";
import { applyAppearance, readAppearance } from "./appearance.js";
import { DesktopWindowFrame } from "./desktop-window-frame.js";
import { initializeAnalytics } from "./analytics.js";
import { initializeRuntimeConnection } from "./runtime-connection.js";
import { RuntimeNotice } from "./runtime-notice.js";
import { ErrorBoundary } from "./error-boundary.js";
import { DesktopCloseGuard } from "./desktop-close-guard.js";
import "./styles.css";
import "./runtime-recovery.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root was not found");
const route = parseAppRoute(window.location.hash);
if (window.ohMyGameDesktop) initSentry();
// The hidden thumbnail window is not a visit.
if (route.page !== "thumbnail") initializeAnalytics();
applyAppearance(readAppearance());
await initializeRuntimeConnection();
if (window.ohMyGameDesktop?.platform === "darwin") {
  document.documentElement.classList.add("desktop-macos");
}
const content = (
  <>
    <RuntimeNotice />
    <ErrorBoundary
      label="Application"
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
            <App />
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
