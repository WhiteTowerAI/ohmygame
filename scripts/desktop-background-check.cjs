const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const directory = process.argv[2];
app.setPath("userData", path.join(directory, "profile"));
process.env.OHMYGAME_DATA_DIR = path.join(directory, "data");
process.env.PI_CODING_AGENT_DIR = path.join(directory, "agent");
process.argv.push("--built-renderer");
const deadline = setTimeout(() => {
  console.error("Desktop background check timed out");
  app.exit(2);
}, 120_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error("Desktop state did not settle");
}

// Exercise the actual entry point, renderer preload, main IPC and native tray on Windows.
require("../dist/desktop/bootstrap.cjs");
(async () => {
  try {
    await until(() =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible()),
    );
    const window = BrowserWindow.getAllWindows().find((window) =>
      window.isVisible(),
    );
    const evaluate = (script) => window.webContents.executeJavaScript(script);
    await until(() =>
      evaluate("Boolean(document.querySelector('.desktop-close-content'))"),
    );
    assert.equal(
      await evaluate("window.ohMyGameDesktop.backgroundRunning.get()"),
      false,
    );
    assert.equal(
      await evaluate("window.ohMyGameDesktop.backgroundRunning.set(true)"),
      true,
    );
    await evaluate(
      "window.backgroundSentinel = 'same renderer'; location.hash = '#/settings'",
    );
    window.close();
    await until(() => !window.isVisible());
    assert.equal(window.isDestroyed(), false);
    assert.equal(await evaluate("window.backgroundSentinel"), "same renderer");
    assert.equal(
      await evaluate(
        "Boolean(document.querySelector('.desktop-close-content[inert]'))",
      ),
      false,
    );
    const second = spawn(
      process.execPath,
      [
        path.resolve(__dirname, ".."),
        "--built-renderer",
        `--user-data-dir=${app.getPath("userData")}`,
      ],
      { env: process.env, stdio: "inherit" },
    );
    const secondCode = await new Promise((resolve, reject) => {
      second.once("error", reject);
      second.once("exit", resolve);
    });
    assert.equal(secondCode, 0);
    await until(() => window.isVisible());
    assert.equal(
      BrowserWindow.getAllWindows().filter((item) => item.isVisible()).length,
      1,
    );
    assert.equal(await evaluate("window.backgroundSentinel"), "same renderer");
    window.webContents.reload();
    await until(() => !window.webContents.isLoading());
    await until(() =>
      evaluate("Boolean(document.querySelector('.desktop-close-content'))"),
    );
    assert.equal(
      await evaluate("window.ohMyGameDesktop.backgroundRunning.get()"),
      true,
    );
    assert.equal(
      await evaluate("window.ohMyGameDesktop.backgroundRunning.set(false)"),
      false,
    );
    assert.equal(
      await evaluate("window.ohMyGameDesktop.backgroundRunning.set(true)"),
      true,
    );
    window.close();
    await until(() => !window.isVisible());
    // Explicit Quit must save and stop services even while the window is hidden.
    app.once("will-quit", () => {
      clearTimeout(deadline);
      writeFileSync(
        path.join(directory, "passed.json"),
        JSON.stringify({
          platform: process.platform,
          electron: process.versions.electron,
          hidden: true,
          restored: true,
          reloaded: true,
          quit: true,
        }),
      );
    });
    app.quit();
  } catch (cause) {
    console.error(cause);
    clearTimeout(deadline);
    app.exit(1);
  }
})();
