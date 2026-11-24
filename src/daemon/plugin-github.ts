import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { GitHubAccountView, GitHubPublished } from "../shared/plugin-setup.js";
import { PLUGIN_MANIFEST_PATH } from "../shared/plugins.js";
import { mapConcurrent } from "./map-concurrent.js";
import type { ConfigurationOwner, PluginConfigurationStore } from "./plugin-configuration.js";
import { exportedName, stageExport } from "./plugin-export.js";
import { localizePluginString, type PluginIndexEntry } from "./plugin-index.js";
import { packRelease } from "./plugin-pack.js";

// "Publish to GitHub" in the Plugin Builder. The person signs in with GitHub's
// device flow; a plugin they made, `personal/<name>`, becomes `<login>/<name>`
// in their public repository `<name>`, with the topic the plugin market
// searches for and a release `v<version>` holding the package as its one
// `.zip`, packed as the market packs one. All through GitHub's REST API, so
// no git is needed. The installed `personal/<name>` stays as it is.

/** WhiteTowerAI's OAuth App "OhMyGame Plugin Publisher". The device flow needs no secret. */
const CLIENT_ID = "Ov23liAF11z3jirdi7hJ";
const API = "https://api.github.com";
const TOPIC = "ohmygame-plugin";
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

/** Kept with connections' secrets: encrypted with the app's private key file. */
const ACCOUNT: ConfigurationOwner = {
  id: "github",
  configuration: { token: { type: "secret", label: "GitHub token" }, login: { type: "text", label: "GitHub account" } },
};

type Fetch = typeof fetch;

export class GitHubError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}

class GitHubSignInError extends GitHubError {}

export class GitHubAccount {
  #signIn?: { view: NonNullable<GitHubAccountView["signIn"]>; controller: AbortController };
  #error?: string;
  readonly #fetch: Fetch;
  readonly #wait: (ms: number, signal: AbortSignal) => Promise<unknown>;

  constructor(private readonly store: PluginConfigurationStore, options: { fetch?: Fetch; wait?: (ms: number, signal: AbortSignal) => Promise<unknown> } = {}) {
    this.#fetch = options.fetch ?? ((...request) => fetch(...request));
    this.#wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  }

  view(): GitHubAccountView {
    const { token, login } = this.store.resolved(ACCOUNT);
    return {
      ...(token && typeof login === "string" ? { login } : {}),
      ...(this.#signIn ? { signIn: this.#signIn.view } : {}),
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  /** Asks GitHub for a code the person enters there, and waits for them in the background. */
  async signIn(): Promise<GitHubAccountView> {
    this.#signIn?.controller.abort();
    this.#signIn = undefined;
    this.#error = undefined;
    const code = await this.#post("https://github.com/login/device/code", { client_id: CLIENT_ID, scope: "public_repo" });
    if (typeof code.device_code !== "string" || typeof code.user_code !== "string" || typeof code.verification_uri !== "string")
      throw new GitHubError(`GitHub didn't start the sign-in: ${code.error_description ?? code.error ?? "no code"}`);
    const expiresIn = Number(code.expires_in) || 900;
    const signIn = {
      view: { userCode: code.user_code, verificationUri: code.verification_uri, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() },
      controller: new AbortController(),
    };
    this.#signIn = signIn;
    const { signal } = signIn.controller;
    void this.#poll(code.device_code, (Number(code.interval) || 5) * 1000, signal)
      .then(async (token) => {
        const login = String((await api(token, this.#fetch).ok("GET", "/user")).login);
        if (!signal.aborted) await this.store.update(ACCOUNT, { token, login });
      })
      .catch((cause: unknown) => {
        if (!signal.aborted) this.#error = cause instanceof Error ? cause.message : String(cause);
      })
      .finally(() => {
        if (this.#signIn === signIn) this.#signIn = undefined;
      });
    return this.view();
  }

  /** Forgets the token. GitHub keeps it until it expires or the person revokes the app there. */
  async signOut(): Promise<void> {
    this.#signIn?.controller.abort();
    this.#signIn = undefined;
    this.#error = undefined;
    await this.store.update(ACCOUNT, { token: null, login: null });
  }

  /** Publishes `entry`, an installed plugin made in the Plugin Builder. */
  async publish(entry: PluginIndexEntry): Promise<GitHubPublished> {
    const { token } = this.store.resolved(ACCOUNT);
    if (typeof token !== "string") throw new GitHubError("Sign in to GitHub first.", 409);
    try {
      return await publish(entry, api(token, this.#fetch));
    } catch (cause) {
      if (cause instanceof GitHubSignInError) await this.store.update(ACCOUNT, { token: null, login: null });
      throw cause;
    }
  }

  async #poll(deviceCode: string, interval: number, signal: AbortSignal): Promise<string> {
    for (;;) {
      await this.#wait(interval, signal);
      const answer = await this.#post("https://github.com/login/oauth/access_token", {
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      if (typeof answer.access_token === "string") return answer.access_token;
      if (answer.error === "authorization_pending") continue;
      // GitHub says how long to wait from now on.
      if (answer.error === "slow_down") interval = (Number(answer.interval) || interval / 1000 + 5) * 1000;
      else if (answer.error === "expired_token") throw new GitHubError("The code expired before it was entered on GitHub. Sign in again.");
      else if (answer.error === "access_denied") throw new GitHubError("The sign-in was cancelled on GitHub.");
      else throw new GitHubError(`GitHub didn't sign you in: ${answer.error_description ?? answer.error ?? "no token"}`);
    }
  }

  async #post(url: string, form: Record<string, string>): Promise<Record<string, any>> {
    const response = await this.#fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(unreachable);
    const body = await response.json().catch(() => ({}));
    if (!response.ok && !body.error) throw new GitHubError(`GitHub answered the sign-in with HTTP ${response.status}`);
    return body;
  }
}

type Api = ReturnType<typeof api>;

/** GitHub's REST API with the person's token. A 401 means the token no longer works. */
function api(token: string, fetch: Fetch) {
  const request = async (method: string, url: string, body?: unknown): Promise<{ status: number; data: any }> => {
    const upload = body instanceof Buffer;
    const response = await fetch(url.startsWith("https://") ? url : `${API}${url}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": upload ? "application/zip" : "application/json" }),
      },
      ...(body === undefined ? {} : { body: upload ? new Uint8Array(body) : JSON.stringify(body) }),
      signal: AbortSignal.timeout(upload ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
    }).catch(unreachable);
    if (response.status === 401) throw new GitHubSignInError("Your GitHub sign-in has expired or was revoked. Sign in to GitHub again.", 409);
    return { status: response.status, data: await response.json().catch(() => undefined) };
  };
  const check = (method: string, url: string, { status, data }: { status: number; data: any }) => {
    if (status >= 300) throw new GitHubError(`GitHub refused ${method} ${url.replace(/\?.*$/, "")}: ${data?.message ?? `HTTP ${status}`}`);
    return data;
  };
  return {
    request,
    check,
    ok: async (method: string, url: string, body?: unknown) => check(method, url, await request(method, url, body)),
  };
}

async function publish(entry: PluginIndexEntry, github: Api): Promise<GitHubPublished> {
  const login = String((await github.ok("GET", "/user")).login);
  const publisher = login.toLowerCase();
  const name = exportedName(entry, publisher);
  const id = `${publisher}/${name}`;
  const tag = `v${entry.version}`;
  const released = () => new GitHubError(`Version ${entry.version} of ${id} is already released on GitHub. Raise the plugin's version, then publish again.`, 409);
  const taken = () => new GitHubError(`Your GitHub account already has a repository named ${name} that isn't this plugin. Rename or delete it on GitHub, or rename the plugin, then publish again.`, 409);
  const work = await mkdtemp(path.join(tmpdir(), "ohmygame-publish-"));
  try {
    const staging = path.join(work, "package");
    await stageExport(entry, publisher, staging);
    const { archive, files } = await packRelease(staging);

    // This plugin's repository, or a new one.
    const repo = `/repos/${login}/${name}`;
    let found = await github.request("GET", repo);
    if (found.status === 404) {
      found = await github.request("POST", "/user/repos", { name, description: localizePluginString(entry, entry.manifest.description, "en"), private: false });
      // A private repository, which the token can't see, has the name.
      if (found.status === 422 && alreadyExists(found.data)) throw taken();
    }
    const repository = github.check("GET", repo, found);
    if (repository.fork || repository.private || String(repository.full_name).toLowerCase() !== `${publisher}/${name}`) throw taken();
    const branch = String(repository.default_branch);
    // An empty repository has no branch yet: GitHub answers 409, or 404.
    const head = await github.request("GET", `${repo}/git/ref/heads/${branch}`);
    let parent: string | undefined;
    if (head.status === 200) {
      parent = String(head.data.object.sha);
      const manifest = await github.request("GET", `${repo}/contents/${PLUGIN_MANIFEST_PATH}?ref=${parent}`);
      if (manifest.status !== 200 || manifestId(manifest.data?.content) !== id) throw taken();
    } else if (head.status !== 404 && head.status !== 409) github.check("GET", `${repo}/git/ref/heads/${branch}`, head);

    // One release for each version.
    if ((await github.request("GET", `${repo}/git/ref/tags/${tag}`)).status === 200) throw released();

    const read = (file: string) => readFile(path.join(staging, ...file.split("/")));
    // Only the contents API writes to an empty repository.
    parent ??= String((await github.ok("PUT", `${repo}/contents/${PLUGIN_MANIFEST_PATH}`, { message: `Publish ${tag}`, content: (await read(PLUGIN_MANIFEST_PATH)).toString("base64") })).commit.sha);
    // The commit holds what the package does, and nothing else.
    const tree = await mapConcurrent(files, 4, async (file) => {
      const [bytes, info] = await Promise.all([read(file), lstat(path.join(staging, ...file.split("/")))]);
      const blob = await github.ok("POST", `${repo}/git/blobs`, { content: bytes.toString("base64"), encoding: "base64" });
      return { path: file, mode: info.mode & 0o111 ? "100755" : "100644", type: "blob", sha: String(blob.sha) };
    });
    const treeSha = String((await github.ok("POST", `${repo}/git/trees`, { tree })).sha);
    const commit = String((await github.ok("POST", `${repo}/git/commits`, { message: `Publish ${tag}`, tree: treeSha, parents: [parent] })).sha);
    await github.ok("PATCH", `${repo}/git/refs/heads/${branch}`, { sha: commit });

    const topics: string[] = Array.isArray(repository.topics) ? repository.topics : [];
    if (!topics.includes(TOPIC)) await github.ok("PUT", `${repo}/topics`, { names: [...topics, TOPIC] });
    const release = await github.request("POST", `${repo}/releases`, { tag_name: tag, target_commitish: commit, name: tag });
    if (release.status === 422 && alreadyExists(release.data)) throw released();
    const { upload_url: upload, html_url: page } = github.check("POST", `${repo}/releases`, release);
    // The workflow a package is exported with attaches one of this name, so there is only ever one.
    await github.ok("POST", `${String(upload).replace(/\{.*\}$/, "")}?name=${encodeURIComponent(`${name}-${tag}.zip`)}`, archive);
    return { id, version: entry.version, repository: String(repository.html_url), release: String(page) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function unreachable(cause: unknown): never {
  throw new GitHubError(`Couldn't reach GitHub: ${cause instanceof Error ? cause.message : String(cause)}`);
}

/** GitHub's answer to making something that is there already. */
function alreadyExists(data: any): boolean {
  return Array.isArray(data?.errors) && data.errors.some((error: any) => error?.code === "already_exists" || /already exists/.test(String(error?.message)));
}

function manifestId(content: unknown): string | undefined {
  try {
    return (JSON.parse(Buffer.from(String(content), "base64").toString("utf8")) as { id?: string }).id;
  } catch {
    return undefined;
  }
}
