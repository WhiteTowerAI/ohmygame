const { app, BrowserWindow, BaseWindow, webContents } = require('electron');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { writeFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const directory = process.argv[2];
app.setPath('userData', path.join(directory, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Desktop game check timed out'); app.exit(2); }, 45000);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate) {
  const end = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error('Condition did not become true');
    await sleep(30);
  }
}
async function fullscreen(window, frame, enabled) {
  console.log(`Fullscreen ${window.getTitle()} ${enabled}`);
  let timer;
  const transition = new Promise((resolve, reject) => {
    window.once(enabled ? 'enter-full-screen' : 'leave-full-screen', resolve);
    timer = setTimeout(() => reject(new Error(`Native fullscreen transition timed out: ${window.getTitle()} ${enabled}`)), 5000);
  });
  try {
    await frame.executeJavaScript(enabled ? 'void document.body.requestFullscreen()' : 'void document.exitFullscreen()', true);
    await transition;
  } finally { clearTimeout(timer); }
}
const html = `<!doctype html><head></head><body style="background:#245;color:white"><h1>Shared game</h1><button id="add">Add point</button><script>
window.game = { id: crypto.randomUUID(), memory: 0, frames: 0 };
window.addEventListener('keydown', event => { game.lastKey = event.key; });
const render = () => { game.frames++; requestAnimationFrame(render); }; requestAnimationFrame(render);
async function database() {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open('qa-game', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('save');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
window.save = async (value) => {
  localStorage.setItem('qaScore', String(value));
  const db = await database();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('save', 'readwrite');
    transaction.objectStore('save').put(value, 'score');
    transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
  }); db.close();
};
window.readSave = async () => {
  const db = await database();
  const value = await new Promise(resolve => {
    const request = db.transaction('save').objectStore('save').get('score');
    request.onsuccess = () => resolve(request.result ?? null);
  }); db.close();
  return { localStorage: localStorage.getItem('qaScore'), indexedDB: value };
};
document.querySelector('#add').onclick = () => { game.memory++; void save(game.memory); };
</script></body>`;
let server, proxy, games;
app.whenReady().then(async () => {
  try {
    const { WebGamePlayerWindows } = await import(pathToFileURL(path.join(root, 'dist/desktop/web-game-player.js')).href);
    const { createPreviewProxy } = await import(pathToFileURL(path.join(root, 'dist/daemon/preview-proxy.js')).href);
    server = createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(html));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const navigation = [], diagnostics = [];
    proxy = await createPreviewProxy(`http://127.0.0.1:${server.address().port}`, (diagnostic, all) => { diagnostics.push(all ?? (diagnostic ? [diagnostic] : [])); }, { onNavigation: (client, source, path) => navigation.push({ client, source, path }) });
    const url = `${proxy.url}/?__ohmygame_client=runtime-check&__ohmygame_view=editor`;
    const oldPath = path.join(directory, 'old-preview.html');
    await writeFile(oldPath, `<iframe src="${proxy.url}/?__ohmygame_client=old-preview&__ohmygame_view=editor" sandbox="allow-scripts allow-same-origin"></iframe>`);
    const old = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await old.loadFile(oldPath);
    await eventually(async () => await old.webContents.mainFrame.frames[0]?.executeJavaScript('typeof save') === 'function');
    await old.webContents.mainFrame.frames[0].executeJavaScript('save(64)');
    old.destroy();
    const editorPath = path.join(directory, 'editor.html');
    await writeFile(editorPath, '<body style="background:#333;color:white"><h1>Editor</h1></body>');
    const editor = new BrowserWindow({ width: 1000, height: 800, show: true });
    await editor.loadFile(editorPath);
    const hostUrl = pathToFileURL(path.join(root, 'dist/renderer/web-game-host.html')).href;
    games = new WebGamePlayerWindows(() => {}, hostUrl);
    editor.on('resize', () => games.synchronize());
    const layout = { bounds: { x: 250, y: 100, width: 600, height: 500 }, visible: true };
    let resolves = 0;
    const target = async () => { resolves++; return { url: proxy.url, title: 'Shared game check' }; };
    await games.attach('game', 'mount', editor, url, layout, target);
    const native = webContents.getAllWebContents().find(contents => contents.getURL() === hostUrl);
    assert.ok(native, 'Native game WebContents exists');
    const frame = () => native.mainFrame.frames.find(frame => frame.url.startsWith(proxy.url));
    assert.deepEqual(await frame().executeJavaScript('readSave()'), { localStorage: '64', indexedDB: 64 }, 'Existing iframe saves are retained');
    assert.equal(await frame().executeJavaScript('typeof window.ohMyGameDesktop'), 'undefined');
    assert.equal(await native.executeJavaScript('typeof window.ohMyGameDesktop'), 'undefined');
    const identity = await frame().executeJavaScript('game.id');
    console.log('Checking native game fullscreen...');
    await fullscreen(editor, frame(), true);
    await fullscreen(editor, frame(), false);
    console.log('Native game fullscreen passed.');
    await frame().executeJavaScript('game.memory = 42; history.pushState({}, "", "/scene?level=2#boss")');
    await eventually(() => navigation.at(-1)?.path === '/scene?level=2#boss');
    const frameId = frame().frameTreeNodeId;
    await fullscreen(editor, frame(), true);
    const editorExit = new Promise(resolve => editor.once('leave-full-screen', resolve));
    await games.open('game', { path: '/', viewport: { width: 375, height: 667 } }, target);
    await editorExit;
    await eventually(() => !editor.isFullScreen());
    assert.equal(resolves, 1, 'Opening Play reuses the existing server and game');
    assert.equal(frame().frameTreeNodeId, frameId, 'Opening Play retains the same frame');
    assert.equal(await frame().executeJavaScript('game.id'), identity);
    assert.equal(await frame().executeJavaScript('game.memory'), 42);
    app.focus({ steal: true });
    native.focus();
    assert.equal(native.focusedFrame?.frameTreeNodeId, frameId, 'Play focuses the game frame');
    await eventually(() => navigation.at(-1)?.source === 'player');
    await frame().executeJavaScript('save(99)');
    await frame().executeJavaScript('setTimeout(() => { throw new Error("QA native game error"); }, 0)');
    await eventually(() => diagnostics.at(-1)?.some(item => item.message.includes('QA native game error') && item.source === 'player'));
    const player = BaseWindow.getAllWindows().find(window => window !== editor);
    assert.ok(player);
    await fullscreen(player, frame(), true);
    await fullscreen(player, frame(), false);
    player.setContentSize(768, 600);
    await eventually(async () => await frame().executeJavaScript('innerWidth') === 768);
    games.layout('game', 'mount', { ...layout, visible: false });
    assert.equal(native.isAudioMuted(), false, 'Editor overlays cannot mute the separate Play window');
    games.closeProject('game');
    assert.equal(games.state('game').open, false);
    assert.equal(frame().frameTreeNodeId, frameId);
    assert.equal(await frame().executeJavaScript('game.memory'), 42);
    assert.deepEqual(await frame().executeJavaScript('readSave()'), { localStorage: '99', indexedDB: 99 });
    const ai = new BrowserWindow({ show: false, webPreferences: { partition: 'qa-ai-game', sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await ai.loadURL(`${proxy.url}/?__ohmygame_client=ai-check&__ohmygame_view=playtest&ohmygamePlaytest=1`);
    await eventually(async () => await ai.webContents.executeJavaScript('typeof readSave') === 'function');
    assert.deepEqual(await ai.webContents.executeJavaScript('readSave()'), { localStorage: null, indexedDB: null }, 'AI partitions cannot alter human saves');
    ai.destroy();
    await eventually(() => navigation.filter(item => item.client === 'runtime-check').at(-1)?.source === 'editor');
    await eventually(() => diagnostics.at(-1)?.some(item => item.message.includes('QA native game error') && item.source === 'editor'));
    assert.equal(native.isAudioMuted(), true, 'Hidden Preview is muted');
    const hiddenState = await frame().executeJavaScript('document.visibilityState');
    assert.equal(hiddenState, 'hidden', 'Hidden native views report background visibility');
    games.layout('game', 'mount', layout);
    await eventually(() => !native.isAudioMuted());
    const image = await games.capture('game');
    assert.ok(image.length > 100, 'Captures the native game itself');
    await games.refresh('game', target, true);
    await eventually(async () => await frame().executeJavaScript('game.id') !== identity);
    assert.notEqual(await frame().executeJavaScript('game.id'), identity, 'An explicit refresh restarts the game');
    assert.deepEqual(await frame().executeJavaScript('readSave()'), { localStorage: '99', indexedDB: 99 });
    assert.equal(await frame().executeJavaScript('location.pathname + location.search.replace(/([?&])__ohmygame_[^&]+/g, "$1").replace(/[?&]+$/, "") + location.hash'), '/scene?level=2#boss');
    native.forcefullyCrashRenderer();
    await eventually(() => !!games.state('game').error);
    await games.refresh('game', target, true);
    assert.equal(games.state('game').error, undefined, 'Refresh recovers a crashed game process');
    assert.deepEqual(await frame().executeJavaScript('readSave()'), { localStorage: '99', indexedDB: 99 });
    assert.equal(await frame().executeJavaScript('location.pathname'), '/scene');
    await games.open('game', { path: '/', viewport: { width: 375, height: 667 } }, target);
    games.detach('game', 'mount');
    assert.equal(native.isDestroyed(), false, 'Play survives leaving the project');
    games.closeProject('game');
    await eventually(() => native.isDestroyed());
    assert.equal(native.isDestroyed(), true, 'Closing the last host releases its game WebContents');
    await games.attach('game', 'again', editor, url, layout, target);
    const reloaded = webContents.getAllWebContents().find(contents => contents.getURL() === hostUrl);
    assert.deepEqual(await reloaded.mainFrame.frames[0].executeJavaScript('readSave()'), { localStorage: '99', indexedDB: 99 });
    games.close();
    await eventually(() => reloaded.isDestroyed());
    assert.equal(reloaded.isDestroyed(), true, 'Service shutdown releases game WebContents');
    console.log(JSON.stringify({ electron: process.versions.electron, checks: 'existing localStorage/IndexedDB saves, live frame identity, in-memory state, game frame focus, routing, source/diagnostics, fullscreen and transfer, resizing, AI storage isolation, visibility/audio, native capture, reload, renderer crash recovery, project leave, shutdown', hiddenVisibility: hiddenState, result: 'passed' }, null, 2));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    clearTimeout(deadline);
    games?.close();
    for (const window of BaseWindow.getAllWindows()) window.destroy();
    await proxy?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    app.exit(process.exitCode || 0);
  }
});
