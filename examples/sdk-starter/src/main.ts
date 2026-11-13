import { init, isOhMyGameError } from "@ohmygame/sdk";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app element.");

const localStatus = "Saves stay in this browser.";

async function start() {
  try {
    const game = await init();
    const saved = await game.storage.get<number>("clicks");
    let clicks =
      typeof saved === "number" && Number.isFinite(saved) ? saved : 0;
    const defaultStatus = game.storage.cloud
      ? "Cloud saves are configured."
      : localStatus;

    app.innerHTML = `
      <section>
        <p class="eyebrow">@ohmygame/sdk</p>
        <h1>SDK starter</h1>
        <p>This counter is saved in this browser through <code>game.storage</code>.</p>
        <p class="count" aria-live="polite"></p>
        <button type="button">Save another click</button>
        <p class="status"></p>
      </section>
    `;

    const button = app.querySelector("button");
    const count = app.querySelector(".count");
    const status = app.querySelector(".status");
    if (!button || !count || !status)
      throw new Error("Missing starter elements.");
    count.textContent = String(clicks);
    status.textContent = defaultStatus;

    button.addEventListener("click", async () => {
      const nextClicks = clicks + 1;
      button.disabled = true;
      try {
        await game.storage.set("clicks", nextClicks);
        clicks = nextClicks;
        count.textContent = String(clicks);
        status.textContent = defaultStatus;
        status.classList.remove("error");
      } catch (error) {
        status.textContent = isOhMyGameError(error)
          ? `${error.code}: ${error.message}`
          : "The counter could not be saved. Please try again.";
        status.classList.add("error");
      } finally {
        button.disabled = false;
      }
    });
  } catch (error) {
    const message = isOhMyGameError(error)
      ? `${error.code}: ${error.message}`
      : "The starter could not initialize.";
    const notice = document.createElement("p");
    notice.className = "error";
    notice.textContent = message;
    app.replaceChildren(notice);
  }
}

void start();
