// The browser half of scripts/plugin-ui-regression.ts: opens each job's page in
// Electron, the Chromium the app ships, and writes down what it finds.
const { app, BrowserWindow } = require('electron');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const [jobFile, resultFile] = process.argv.slice(2);
const WIDTH = 1100;
const HEIGHT = 800;
const TALLEST = 4000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Panel regression check timed out'); app.exit(2); }, 240_000);
app.on('window-all-closed', () => {});
// Pictures from the software renderer come out the same each time, and CI has no GPU.
app.disableHardwareAcceleration();

/** Waits for the page to stop changing: two pictures in a row with the same pixels. */
async function settledPicture(contents) {
  let image = await contents.capturePage();
  for (let tries = 0; tries < 30; tries++) {
    await sleep(150);
    const next = await contents.capturePage();
    if (next.toBitmap().equals(image.toBitmap())) return next;
    image = next;
  }
  return image;
}

async function runJob(job, origins) {
  const issues = [];
  const window = new BrowserWindow({ show: false, width: WIDTH, height: HEIGHT, useContentSize: true, enableLargerThanScreen: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const contents = window.webContents;
  contents.setFrameRate(10);
  // Each run has its own ports, so an address would make every message new.
  const plain = (text) => origins.reduce((all, origin) => all.split(origin).join('<origin>'), text);
  contents.on('console-message', (details) => {
    if (details.level === 'error') issues.push(`console: ${plain(details.message)}`);
  });
  contents.on('render-process-gone', (_event, details) => issues.push(`the page crashed: ${details.reason}`));
  await contents.loadURL(job.url);
  // The app shows a frame within 3 seconds, whether or not its page connects.
  let ready = false;
  for (let waited = 0; waited < 3000 && !ready; waited += 100) {
    ready = await contents.executeJavaScript('window.pluginReady === true');
    if (!ready) await sleep(100);
  }
  if (!ready) issues.push('the page never connected to the app');
  await sleep(700);
  const frame = contents.mainFrame.frames[0];
  if (!frame) issues.push('the page has no frame');
  else {
    const undefinedTags = await frame.executeJavaScript(`[...new Set([...document.querySelectorAll('*')].map((element) => element.localName).filter((name) => name.startsWith('omg-') && !customElements.get(name)))]`);
    for (const tag of undefinedTags) issues.push(`<${tag}> never registered`);
    const height = await frame.executeJavaScript('Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)');
    window.setContentSize(WIDTH, Math.min(TALLEST, Math.max(HEIGHT, height)));
    await sleep(300);
    // Transitions end; what repeats stops at its start, as a spinner in a different place is not a change.
    // A document's list leaves out its shadow trees, where the components' spinners are.
    await frame.executeJavaScript(`(function settle(root) {
      for (const animation of root.getAnimations()) {
        if (animation.effect?.getComputedTiming().iterations === Infinity) { animation.pause(); animation.currentTime = 0; }
        else animation.finish();
      }
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot) settle(element.shadowRoot);
    })(document)`);
  }
  const image = await settledPicture(contents);
  let file;
  if (image.isEmpty()) issues.push('the page drew nothing');
  else {
    await mkdir(path.dirname(job.file), { recursive: true });
    await writeFile(job.file, image.toPNG());
    file = job.file;
  }
  window.destroy();
  return { plugin: job.plugin, panel: job.panel, ...(job.scenario ? { scenario: job.scenario } : {}), appearance: job.appearance, issues: [...new Set(issues)], ...(file ? { file } : {}) };
}

app.whenReady().then(async () => {
  try {
    const { jobs, origins, profile } = JSON.parse(await readFile(jobFile, 'utf8'));
    app.setPath('userData', profile);
    const results = [];
    for (const job of jobs) results.push(await runJob(job, origins));
    await writeFile(resultFile, JSON.stringify(results));
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
