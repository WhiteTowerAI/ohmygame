import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { AuthProvider } from "./auth.js";
import { PlaytestPage } from "./playtest.js";
import { parseAppRoute } from "./routes.js";
import { applyAppearance, readAppearance } from "./appearance.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root was not found");
applyAppearance(readAppearance());
if (window.ohMyGameDesktop?.platform === "darwin") {
  document.documentElement.classList.add("desktop-macos");
}
const route = parseAppRoute(window.location.hash);
createRoot(root).render(route.page === "playtest"
  ? <PlaytestPage projectId={route.projectId} chapterId={route.chapterId} />
  : <AuthProvider><App /></AuthProvider>);
