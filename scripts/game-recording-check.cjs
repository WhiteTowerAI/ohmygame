// Records a real game page in Electron, then reads the file back: what the
// unit tests can't show, because it depends on this platform's encoders.
const { app, BaseWindow, BrowserWindow, WebContentsView } = require('electron');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { copyFile, mkdtemp, stat } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const directory = process.argv[2];
app.setPath('userData', path.join(directory, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Game recording check timed out'); app.exit(2); }, 90_000);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const html = `<!doctype html><body style="margin:0;background:#123;overflow:hidden"><canvas id="c" width="1280" height="720" style="width:100vw;height:100vh"></canvas><div style="position:fixed;top:8px;left:8px;color:#fff">HUD</div><script>
const g = c.getContext('2d'); window.frames = 0;
const render = () => { window.frames++; g.fillStyle = 'hsl(' + (window.frames % 360) + ',80%,50%)'; g.fillRect(0, 0, 1280, 720); requestAnimationFrame(render); }; render();
window.startTone = () => { const a = new AudioContext(); const o = a.createOscillator(); o.connect(a.destination); o.start(); return a.state; };
</script></body>`;
let server;
/** What the file holds, as read by the library the trimmer uses. */
async function readBack(file) {
  const { ALL_FORMATS, FilePathSource, Input } = await import('mediabunny');
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  const stats = await video.computePacketStats();
  return { container: (await input.getFormat()).name, duration: await input.computeDuration(), fps: stats.averagePacketRate, video: video && { codec: video.codec, width: video.displayWidth, height: video.displayHeight }, audio: audio && { codec: audio.codec } };
}
app.whenReady().then(async () => {
  try {
    const { GameRecorder } = await import(pathToFileURL(path.join(root, 'dist/desktop/game-recorder.js')).href);
    server = createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(html));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const kept = await mkdtemp(path.join(directory, 'kept-'));
    const files = [];
    const recorder = new GameRecorder({
      hostUrl: pathToFileURL(path.join(root, 'dist/renderer/game-recorder.html')).href,
      preloadPath: path.join(root, 'dist/desktop/game-recorder-preload.cjs'),
      save: async (file) => {
        const copy = path.join(kept, `${files.length}.${file.extension}`);
        await copyFile(file.path, copy);
        files.push({ ...file, copy });
        return { assetId: String(files.length), name: path.basename(copy), duration: file.duration, bytes: file.bytes };
      },
    });
    const owner = new BrowserWindow({ show: false, width: 1280, height: 720, useContentSize: true });
    const other = new BrowserWindow({ show: false, width: 500, height: 500, useContentSize: true });
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    owner.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1280, height: 720 });
    await view.webContents.loadURL(url);
    await view.webContents.executeJavaScript('window.startTone()', true);
    const frames = () => view.webContents.executeJavaScript('window.frames');
    const results = {};
    const expectVideo = async (name, saved, { aspect, seconds, minEdge }) => {
      const file = files.at(-1);
      assert.equal(saved.name, path.basename(file.copy));
      const info = await readBack(file.copy);
      results[name] = { ...info, bytes: (await stat(file.copy)).size, mediaType: file.mediaType };
      // The video follows the game's rendered pixels, so a high-density screen fills the limit sooner.
      assert.ok(Math.max(info.video.width, info.video.height) <= 1280 && Math.max(info.video.width, info.video.height) >= minEdge, `${name}: video is ${info.video.width}x${info.video.height}`);
      assert.ok(info.fps >= 20, `${name}: video has ${info.fps} frames a second`);
      assert.ok(Math.abs(info.video.width / info.video.height - aspect) < 0.02, `${name}: video is ${info.video.width}x${info.video.height}, expected a shape of ${aspect}`);
      assert.ok(info.audio, `${name}: has audio`);
      assert.ok(Math.abs(info.duration - seconds) < 1.5, `${name}: lasted ${info.duration} s, expected about ${seconds}`);
      assert.ok(file.bytes > 10_000, `${name}: holds real video`);
    };

    // Moving to another window, as Play does, and resizing keep the first size.
    console.log('Recording while moving the game...');
    let { outcome } = await recorder.start('moves', view.webContents, { title: 'Check', maxSeconds: 60 });
    await sleep(1500);
    owner.contentView.removeChildView(view);
    other.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 500, height: 500 });
    await sleep(1500);
    assert.equal(recorder.isRecording('moves'), true);
    recorder.stop('moves');
    await expectVideo('moved', await outcome, { aspect: 16 / 9, seconds: 3, minEdge: 1280 });
    assert.equal(recorder.isRecording('moves'), false);

    // A second recording in the same process, in the view's new shape.
    console.log('Recording again in a new shape, hidden...');
    view.setVisible(false);
    const before = await frames();
    ({ outcome } = await recorder.start('again', view.webContents, { title: 'Check', maxSeconds: 2 }));
    await expectVideo('again', await outcome, { aspect: 1, seconds: 2, minEdge: 500 });
    const gameFps = (await frames() - before) / 2;
    results.gameFramesPerSecondWhileHidden = gameFps;
    assert.ok(gameFps > 20, `The game kept running while it recorded, at ${gameFps} frames a second`);
    view.setVisible(true);

    // Closing the game keeps what was recorded.
    console.log('Recording until the game closes...');
    const contents = view.webContents;
    ({ outcome } = await recorder.start('closes', contents, { title: 'Check', maxSeconds: 60 }));
    await sleep(1500);
    contents.close({ waitForBeforeUnload: false });
    await expectVideo('closed', await outcome, { aspect: 1, seconds: 1.5, minEdge: 500 });

    // An agent's playtest window, which is hidden and muted unless watched.
    console.log('Recording an agent playtest...');
    const { ElectronPlaytestDriver } = await import(pathToFileURL(path.join(root, 'dist/desktop/playtest-driver.js')).href);
    const driver = new ElectronPlaytestDriver(undefined, undefined, recorder);
    const opened = await driver.request({ operation: 'open', target: { runtime: 'web', url }, viewport: { width: 480, height: 640 } });
    const { sessionId } = opened.snapshot;
    await driver.request({ operation: 'recordStart', sessionId });
    await driver.request({ operation: 'act', sessionId, actions: [{ type: 'wait', milliseconds: 2000 }] });
    const { recording } = await driver.request({ operation: 'recordStop', sessionId });
    await expectVideo('agent', recording, { aspect: 3 / 4, seconds: 2, minEdge: 600 });
    driver.close();

    await assert.rejects(recorder.start('gone', contents, { title: 'Check', maxSeconds: 60 }), /no longer running/);
    recorder.close();
    console.log(JSON.stringify({ electron: process.versions.electron, platform: process.platform, results, result: 'passed' }, null, 2));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    clearTimeout(deadline);
    for (const window of BaseWindow.getAllWindows()) window.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    app.exit(process.exitCode || 0);
  }
});
