// The page's own behaviour. The components connect themselves; this asks the
// app about the project. Pages can't load scripts from other sites.
import { connect } from "/_ohmygame/plugin-ui.js";

const host = await connect();
const project = await host.request("project.info");
document.getElementById("project").textContent = `${project.name} (${project.type})`;
