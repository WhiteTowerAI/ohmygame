import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { AuthProvider } from "./auth.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root was not found");
if (window.openGameDesktop?.platform === "darwin") {
  document.documentElement.classList.add("desktop-macos");
}
createRoot(root).render(<AuthProvider><App /></AuthProvider>);
