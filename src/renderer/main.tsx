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
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root was not found");
const route = parseAppRoute(window.location.hash);
if (window.ohMyGameDesktop) initSentry();
// The hidden thumbnail window is not a visit.
if (route.page !== "thumbnail") initializeAnalytics();
applyAppearance(readAppearance());
if (window.ohMyGameDesktop?.platform === "darwin") {
  document.documentElement.classList.add("desktop-macos");
}
createRoot(root).render(route.page === "playtest"
  ? <PlaytestPage projectId={route.projectId} />
  : route.page === "thumbnail"
    ? <NodeThumbnailPage projectId={route.projectId} nodeId={route.nodeId} />
    : <DesktopWindowFrame><AuthProvider><App /></AuthProvider></DesktopWindowFrame>);
