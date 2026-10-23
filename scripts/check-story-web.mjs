import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

/** Exercise shipped resources through the running daemon, including ASAR builds. */
export async function checkStoryWeb(runtime) {
  const headers = {
    authorization: `Bearer ${runtime.token}`,
  };
  const request = async (route, method = "GET", body, status = 200) => {
    const response = await fetch(`${runtime.url}${route}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${route}: ${text}`);
    const version = response.headers.get("x-workspace-version");
    if (version) headers["x-workspace-version"] = version;
    return JSON.parse(text);
  };
  const project = await request(
    "/projects",
    "POST",
    { name: "Story runtime check", type: "interactive-story" },
    201,
  );
  const entry = path.join(project.workspacePath, "story/story-web/runtime.js");
  assert.match(
    await readFile(entry, "utf8"),
    /The story runtime a web story project carries/,
  );

  // Simulate a pre-web story, then use the same migration as the Upgrade button.
  await rm(path.join(project.workspacePath, "index.html"));
  await rm(path.join(project.workspacePath, "story"), { recursive: true });
  const route = `/projects/${project.id}`;
  const upgraded = await request(`${route}/interactive-story/upgrade`, "POST");
  assert(upgraded.changed.includes("story/story-web/runtime.js"));
  assert.equal((await request(`${route}/interactive-story/upgrade`)).web, true);
  assert.match(
    await readFile(entry, "utf8"),
    /The story runtime a web story project carries/,
  );

  const preview = await request(`${route}/preview?reuse=1`, "POST");
  try {
    const page = await fetch(preview.url, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /story\/story-web\/runtime\.js/);
    assert.match(html, /__ohmygame_story_bridge__\.js/);
    const script = await fetch(
      new URL("story/story-web/runtime.js", preview.url),
      {
        signal: AbortSignal.timeout(5_000),
      },
    );
    assert.equal(script.status, 200);
    assert.equal(await script.text(), await readFile(entry, "utf8"));
    const bridge = await fetch(
      new URL("/__ohmygame_story_bridge__.js", preview.url),
      {
        signal: AbortSignal.timeout(5_000),
      },
    );
    assert.equal(bridge.status, 200);
    assert.match(await bridge.text(), /ohmygame:playable:snapshot/);
  } finally {
    await request(`${route}/preview`, "DELETE");
  }
}
