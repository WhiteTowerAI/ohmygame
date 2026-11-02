// The browser half of scripts/plugin-ui-regression.ts: opens each job's page in
// Electron, the Chromium the app ships, and writes down what it finds.
const { app, BrowserWindow } = require('electron');
const { createHash } = require('node:crypto');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const [jobFile, resultFile] = process.argv.slice(2);
const WIDTH = 1100;
const HEIGHT = 800;
const TALLEST = 4000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Panel regression check timed out'); app.exit(2); }, 360_000);
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

/**
 * Each closed tab of the page, in document order: its name for the report and
 * what to open to show it, outer tabs first. Each is shown from the page's
 * starting state, so one picture doesn't depend on the last.
 */
const CLOSED_TABS = `(() => {
  const groups = [...document.querySelectorAll('omg-tabs')];
  const start = groups.map((group) => group.value);
  window.__omgRegressionTabs = { groups, start };
  const seen = new Set();
  return groups.flatMap((group, at) =>
    [...group.children].filter((tab) => tab.localName === 'omg-tab' && tab.hidden && !tab.hasAttribute('disabled')).map((tab) => {
      const open = [[at, tab.getAttribute('name')]];
      for (let outer = group.parentElement?.closest('omg-tab'); outer; outer = outer.parentElement?.closest('omg-tab'))
        if (outer.parentElement?.localName === 'omg-tabs') open.unshift([groups.indexOf(outer.parentElement), outer.getAttribute('name')]);
      const path = open.map(([, name]) => name).join(' / ');
      // Groups can repeat a path, and a numbered one can match another name, so count until it's new.
      let label = path;
      for (let count = 2; seen.has(label); count++) label = path + ' #' + count;
      seen.add(label);
      return { label, open };
    }),
  );
})()`;
const showTab = (open) => `(() => {
  const { groups, start } = window.__omgRegressionTabs;
  groups.forEach((group, at) => { group.value = start[at]; });
  for (const [at, name] of ${JSON.stringify(open)}) groups[at].value = name;
})()`;

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
  let connected = false;
  for (let waited = 0; waited < 3000 && !connected; waited += 100) {
    connected = await contents.executeJavaScript('window.pluginReady === true');
    if (!connected) await sleep(100);
  }
  await sleep(700);
  const frame = contents.mainFrame.frames[0];
  if (!frame) issues.push('the page has no frame');
  else {
    const undefinedTags = await frame.executeJavaScript(`[...new Set([...document.querySelectorAll('*')].map((element) => element.localName).filter((name) => name.startsWith('omg-') && !customElements.get(name)))]`);
    for (const tag of undefinedTags) issues.push(`<${tag}> never registered`);
  }
  /** Draws the page as it now is and reports on it, with what went wrong since the last report. */
  const report = async (scenario, target) => {
    if (frame) {
      // A page is at least as tall as its window, so the last picture's height would carry over.
      window.setContentSize(WIDTH, HEIGHT);
      await sleep(300);
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
    if (image.isEmpty()) issues.push(`the page drew nothing${scenario === job.scenario ? '' : ` (${scenario})`}`);
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, image.toPNG());
      file = target;
    }
    return { plugin: job.plugin, panel: job.panel, ...(scenario ? { scenario } : {}), appearance: job.appearance, connected, issues: [], ...(file ? { file } : {}) };
  };
  const results = [await report(job.scenario, job.file)];
  // A closed tab isn't drawn, so each of the page's tabs gets its own picture.
  const closed = frame ? await frame.executeJavaScript(CLOSED_TABS) : [];
  for (const { label, open } of closed) {
    await frame.executeJavaScript(showTab(open));
    await sleep(100);
    // A name can hold anything, and two can differ only in what a file name can't.
    const safe = createHash('sha256').update(label).digest('hex').slice(0, 12);
    results.push(await report([job.scenario, `tab ${label}`].filter(Boolean).join(', '), job.file.replace(/(\.[^.]+\.png)$/, `-tab-${safe}$1`)));
  }
  // An error may come at any moment, so what went wrong belongs to the page, not to whichever picture was next.
  results[0].issues = [...new Set(issues)];
  window.destroy();
  return results;
}

app.whenReady().then(async () => {
  try {
    const { jobs, origins, profile } = JSON.parse(await readFile(jobFile, 'utf8'));
    app.setPath('userData', profile);
    const results = [];
    for (const job of jobs) results.push(...(await runJob(job, origins)));
    await writeFile(resultFile, JSON.stringify(results));
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
