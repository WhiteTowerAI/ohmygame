import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yauzl, { type Entry } from "yauzl";
// @ts-expect-error Standalone plugin JavaScript.
import { packageH5 } from "../plugins/taptap/skills/taptap-h5-publish/scripts/package-h5.mjs";
// @ts-expect-error Standalone plugin JavaScript.
import { createService, cliRunner } from "../plugins/taptap/native/service.mjs";

// @ts-expect-error Standalone plugin JavaScript.
import { waitForOwned } from "../plugins/taptap/native/index.mjs";

let directory: string;
let workspace: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "omg-taptap-"));
  workspace = path.join(directory, "game");
  await mkdir(path.join(workspace, "dist/assets"), { recursive: true });
  await writeFile(
    path.join(workspace, "dist/index.html"),
    '<script src="./assets/game.js"></script>',
  );
  await writeFile(path.join(workspace, "dist/assets/game.js"), "123456789");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function unzip(
  file: string,
): Promise<{ name: string; bytes: Buffer; crc: number }[]> {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const files: { name: string; bytes: Buffer; crc: number }[] = [];
      zip.on("error", reject);
      zip.on("end", () => resolve(files));
      zip.on("entry", (entry: Entry) =>
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(error);
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            files.push({
              name: entry.fileName,
              bytes: Buffer.concat(chunks),
              crc: entry.crc32,
            });
            zip.readEntry();
          });
        }),
      );
      zip.readEntry();
    }),
  );
}

describe("TapTap H5 packages", () => {
  it("preserves web files under a single game root, with verified CRC and UTF-8 paths", async () => {
    await writeFile(path.join(workspace, "dist/assets/图片.txt"), "世界");
    await writeFile(path.join(workspace, "dist/assets/empty.txt"), "");
    await writeFile(path.join(workspace, "dist/.DS_Store"), "metadata");
    await mkdir(path.join(workspace, "dist/.well-known"));
    await writeFile(
      path.join(workspace, "dist/.well-known/site.txt"),
      "public",
    );
    const result = await packageH5("dist", "game.zip", workspace);
    const entries = await unzip(result.path);
    expect(entries.map((file) => file.name)).toEqual([
      "game/.well-known/site.txt",
      "game/assets/empty.txt",
      "game/assets/game.js",
      "game/assets/图片.txt",
      "game/index.html",
    ]);
    expect(entries.find((file) => file.name.endsWith("game.js"))).toMatchObject(
      { crc: 0xcbf43926, bytes: Buffer.from("123456789") },
    );
    expect(
      entries.find((file) => file.name.endsWith("图片.txt"))?.bytes.toString(),
    ).toBe("世界");
    expect(result.warnings).toHaveLength(1);
    const bytes = await readFile(result.path);
    expect(result).toMatchObject({
      files: 5,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const second = await packageH5("dist", "second.zip", workspace);
    expect(second.sha256).toBe(result.sha256);
  });

  it("preserves existing outputs and never packages its output or files outside the workspace", async () => {
    await writeFile(path.join(workspace, "game.zip"), "keep");
    await expect(
      packageH5("dist", "game.zip", workspace),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path.join(workspace, "game.zip"), "utf8")).toBe(
      "keep",
    );
    await expect(packageH5("dist", "dist/game.zip", workspace)).rejects.toThrow(
      "outside the build",
    );
    await expect(packageH5("dist", "../game.zip", workspace)).rejects.toThrow(
      "inside the game workspace",
    );
  });

  it("rejects a source directory, missing entry and symlinks instead of silently shipping them", async () => {
    await expect(
      packageH5("dist/assets", "bad.zip", workspace),
    ).rejects.toThrow("index.html");
    await writeFile(path.join(workspace, "dist/.env.local"), "private");
    await expect(packageH5("dist", "bad.zip", workspace)).rejects.toThrow(
      "credential",
    );
    await rm(path.join(workspace, "dist/.env.local"));
    // Directory junctions also work without Windows symlink privileges.
    await symlink(
      path.join(workspace, "dist/assets"),
      path.join(workspace, "dist/linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(packageH5("dist", "bad.zip", workspace)).rejects.toThrow(
      "Symbolic links",
    );
    expect(await readdir(workspace)).toEqual(["dist"]);
  });
});

const ok = (data: unknown) => ({ ok: true, data });
function fixture(
  upload = async () => ok({ artifactId: 81, h5PackageId: 82, h5VersionId: 83 }),
) {
  const run = vi.fn(async (args: string[]) => {
    const command = args.slice(0, 2).join(" ");
    if (args[0] === "version")
      return ok({ version: "2026.11.12", contract: "3" });
    if (command === "auth status")
      return ok({
        hasAccessToken: true,
        accessTokenExpired: false,
        accessToken: "must-not-escape",
      });
    if (command === "package-management get-available-package-types")
      return ok({ result: { available_package_types: ["h5"] } });
    if (command === "app get-module")
      return ok({ result: { fields: { title: { current_value: "Demo" } } } });
    if (args[0] === "upload-h5-package")
      return args.includes("--dry-run")
        ? ok({
            archive_preflight: { violations: [], top_level_entries: ["game"] },
          })
        : upload();
    if (command === "package-management get-h5-package-upload-status")
      return ok({
        result: { status: "ready", package_id: 82, artifact_id: 81 },
      });
    throw new Error(`Unexpected call: ${command}`);
  });
  const options = { workspace, directory: path.join(directory, "state"), run };
  return { run, options, service: createService(options) };
}

describe("TapTap panel upload ownership", () => {
  it("previews, uploads once, and reads parsing by artifact ID without binding or publishing", async () => {
    const { service, run, options } = fixture();
    await service.select({ developerId: 11, appId: 22 });
    const prepared = await service.prepare({
      buildFolder: "dist",
      orientation: 1,
    });
    const uploaded = await service.upload({ preparedId: prepared.id });
    expect(uploaded).toMatchObject({
      state: "uploaded",
      receipt: { artifactId: 81 },
    });
    await expect(service.upload({ preparedId: prepared.id })).rejects.toThrow(
      "already started",
    );
    const restored = createService(options);
    expect((await restored.status()).cli).toEqual({
      signedIn: true,
      version: "2026.11.12",
    });
    expect(await restored.reconcile({ uploadId: prepared.id })).toMatchObject({
      state: "ready",
    });
    const writes = run.mock.calls
      .map(([args]) => args)
      .filter((args) => args.includes("--yes"));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(
      expect.arrayContaining([
        "--dev-id",
        "11",
        "--app-id",
        "22",
        "--screen-orientation",
        "1",
        "--idempotency-key",
        prepared.id,
      ]),
    );
    expect(run.mock.calls.at(-1)?.[0]).toEqual([
      "package-management",
      "get-h5-package-upload-status",
      "--dev-id",
      "11",
      "--app-id",
      "22",
      "--data",
      '{"artifact_id":81}',
    ]);
    const stored = await readFile(
      path.join(options.directory, (await readdir(options.directory))[0]!),
      "utf8",
    );
    expect(stored).not.toContain("must-not-escape");
  });

  it("rejects changed artifacts and stale preview IDs before any remote upload", async () => {
    const { service, run } = fixture();
    await service.select({ developerId: 11, appId: 22 });
    const prepared = await service.prepare({
      buildFolder: "dist",
      orientation: 0,
    });
    await expect(service.upload({ preparedId: "old" })).rejects.toThrow(
      "current package",
    );
    await writeFile(prepared.path, "changed");
    await expect(service.upload({ preparedId: prepared.id })).rejects.toThrow(
      "changed since preflight",
    );
    expect(run.mock.calls.some(([args]) => args.includes("--yes"))).toBe(false);
  });

  it("keeps an upload alive for status readers, prevents concurrent mutation, and reconciles partial success", async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const { service, options } = fixture(
      async () => pending as Promise<ReturnType<typeof ok>>,
    );
    await service.select({ developerId: 11, appId: 22 });
    const prepared = await service.prepare({
      buildFolder: "dist",
      orientation: 0,
    });
    const upload = service.upload({ preparedId: prepared.id });
    await vi.waitFor(async () =>
      expect((await service.status()).uploading).toBe(true),
    );
    await expect(
      service.select({ developerId: 11, appId: 23 }),
    ).rejects.toThrow("still running");
    finish({
      ok: false,
      data: { artifactId: 81 },
      error: { message: "Readback interrupted" },
    });
    expect(await upload).toMatchObject({
      state: "unknown",
      receipt: { artifactId: 81 },
    });
    const restored = createService(options);
    await expect(
      restored.prepare({ buildFolder: "dist", orientation: 0 }),
    ).rejects.toThrow("Reconcile");
    expect(await restored.reconcile({ uploadId: prepared.id })).toMatchObject({
      state: "ready",
    });
  });

  it("invalidates an old preview when the next preparation fails", async () => {
    const { service, options } = fixture();
    await service.select({ developerId: 11, appId: 22 });
    const prepared = await service.prepare({
      buildFolder: "dist",
      orientation: 0,
    });
    await expect(
      service.prepare({ buildFolder: "missing", orientation: 1 }),
    ).rejects.toThrow();
    expect((await createService(options).status()).prepared).toBeUndefined();
    await expect(service.upload({ preparedId: prepared.id })).rejects.toThrow(
      "current package",
    );
  });

  it("keeps missing receipts unknown and accepts only a matching recovered artifact", async () => {
    const { service, options, run } = fixture(async () => ok({}));
    await service.select({ developerId: 11, appId: 22 });
    const prepared = await service.prepare({
      buildFolder: "dist",
      orientation: 0,
    });
    expect(await service.upload({ preparedId: prepared.id })).toMatchObject({
      state: "unknown",
    });
    await expect(
      service.reconcile({ uploadId: prepared.id, artifactId: 81 }),
    ).rejects.toThrow("filename");
    const restored = createService(options);
    expect((await restored.status()).uploads[0]).toMatchObject({
      state: "unknown",
      receipt: {},
    });
    run.mockResolvedValueOnce(
      ok({
        result: {
          status: "ready",
          file_name: path.basename(prepared.path),
          package_id: 82,
        },
      }),
    );
    expect(
      await restored.reconcile({ uploadId: prepared.id, artifactId: 81 }),
    ).toMatchObject({
      state: "ready",
      receipt: { artifactId: 81, h5PackageId: 82 },
    });
  });

  it("restores interrupted uploads as unknown while preserving extra state", async () => {
    const { service, options } = fixture();
    await service.select({ developerId: 11, appId: 22 });
    const prepared = await service.prepare({
      buildFolder: "dist",
      orientation: 0,
    });
    await service.upload({ preparedId: prepared.id });
    const file = path.join(
      options.directory,
      (await readdir(options.directory))[0]!,
    );
    const state = JSON.parse(await readFile(file, "utf8"));
    state.uploads[0].state = "uploading";
    state.extension = { keep: true };
    await writeFile(file, JSON.stringify(state));
    expect((await createService(options).status()).uploads[0].state).toBe(
      "unknown",
    );
    expect(JSON.parse(await readFile(file, "utf8")).extension).toEqual({
      keep: true,
    });
  });

  it.each([
    { version: 9, future: "keep" },
    { version: 1, uploads: [null], future: "keep" },
  ])(
    "preserves unreadable state instead of replacing it with an empty store: %j",
    async (unreadable) => {
      const { service, options } = fixture();
      await service.select({ developerId: 11, appId: 22 });
      const file = path.join(
        options.directory,
        (await readdir(options.directory))[0]!,
      );
      const future = JSON.stringify(unreadable);
      await writeFile(file, future);
      await expect(createService(options).status()).rejects.toThrow(
        "Unsupported",
      );
      expect(await readFile(file, "utf8")).toBe(future);
    },
  );
});

describe("TapTap CLI lifetime", () => {
  it("settles cancelled host waiters without cancelling their upload owner", async () => {
    let finish!: (value: string) => void;
    const owner = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const controller = new AbortController();
    const first = waitForOwned(() => owner, controller.signal);
    const second = waitForOwned(() => owner, new AbortController().signal);
    const cancelled = expect(first).rejects.toThrow("call cancelled");
    controller.abort();
    await cancelled;
    finish("uploaded");
    expect(await second).toBe("uploaded");
    const work = vi.fn();
    await expect(waitForOwned(work, controller.signal)).rejects.toThrow(
      "call cancelled",
    );
    expect(work).not.toHaveBeenCalled();
  });

  it("retains failure receipts and does not expose unstructured stderr", async () => {
    const run = cliRunner(
      process.execPath,
      workspace,
      new AbortController().signal,
    );
    expect(
      await run([
        "-e",
        "process.stdout.write(JSON.stringify({ok:false,data:{artifactId:81}}));process.exitCode=1",
      ]),
    ).toMatchObject({ ok: false, data: { artifactId: 81 } });
    await expect(
      run([
        "-e",
        'process.stderr.write("private-credential");process.exitCode=1',
      ]),
    ).rejects.toThrow("did not return JSON");
  });

  it.skipIf(process.platform === "win32")(
    "stops the CLI wrapper and its native child when the plugin is disposed",
    async () => {
      const controller = new AbortController();
      const run = cliRunner(process.execPath, workspace, controller.signal);
      const pidFile = path.join(workspace, "child.pid");
      const pending = run([
        "-e",
        `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000)`,
      ]);
      const stopped = expect(pending).rejects.toThrow("plugin stopped");
      let childPid = 0;
      try {
        await vi.waitFor(async () => {
          childPid = Number(await readFile(pidFile, "utf8"));
          expect(childPid).toBeGreaterThan(0);
        });
        controller.abort();
        await stopped;
        await vi.waitFor(() =>
          expect(() => process.kill(childPid, 0)).toThrow(),
        );
      } finally {
        controller.abort();
        if (childPid) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            /* Already stopped. */
          }
        }
      }
    },
  );
});

// @ts-expect-error Standalone plugin JavaScript.
import * as workspaceTools from "../plugins/taptap/native/workspace.mjs";
const { discoverWorkspace, fetchStoreImage } = workspaceTools;

describe("TapTap draft management", () => {
  function draftFixture() {
    let fields: Record<string, any> = {
      title: {
        field_id: "title",
        input_type: "text",
        label: "Title",
        current_value: "Demo",
      },
      description: {
        field_id: "description",
        input_type: "textarea",
        label: "Description",
      },
    };
    let slot: any = { kind: "none" };
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      const data = args.includes("--data")
        ? JSON.parse(args[args.indexOf("--data") + 1]!)
        : {};
      if (args[1] === "get-available-package-types")
        return ok({ result: { available_package_types: ["h5"] } });
      if (args[1] === "get-module")
        return ok({ result: { fields: structuredClone(fields) } });
      if (args[1] === "list-versions")
        return ok({ result: { list: [{ status: "draft", version: "v1" }] } });
      if (args[1] === "list-packages")
        return ok({
          result: {
            list: [{ type: "h5", package_id: "83", status: "ready" }],
            package_slots: { main: { available: true, expected: slot } },
          },
        });
      if (args.includes("--dry-run")) return ok({ status: "preview" });
      if (args[1] === "save-changes") {
        for (const c of data.changes)
          fields[c.field_id].current_value = c.value;
        return ok({
          result: {
            updated_fields: data.changes.map((c: any) => c.field_id),
            stale: [],
          },
        });
      }
      if (args[1] === "select-package") {
        slot = { kind: "h5", h5_version_id: data.package.id };
        return ok({ result: {} });
      }
      throw new Error(`Unexpected ${args.join(" ")}`);
    });
    const service = createService({
      workspace,
      directory: path.join(directory, "draft-state"),
      run,
    });
    return {
      service,
      run,
      calls,
      fields,
      setSlot: (value: any) => {
        slot = value;
      },
    };
  }
  it("discovers workspace builds and images without following symlinks or scanning dependency trees", async () => {
    await mkdir(path.join(workspace, "node_modules/other"), {
      recursive: true,
    });
    await writeFile(
      path.join(workspace, "node_modules/other/index.html"),
      "dependency",
    );
    await writeFile(path.join(workspace, "dist/cover.png"), "image");
    await symlink(directory, path.join(workspace, "outside"));
    const found = await discoverWorkspace(workspace);
    expect(found.builds.map((item: any) => item.folder)).toEqual(["dist"]);
    expect(found.images.map((item: any) => item.path)).toEqual([
      "dist/cover.png",
    ]);
  });
  it("saves only requested fields using the original expected snapshot and one intent, then reads back", async () => {
    const f = draftFixture();
    await f.service.select({ developerId: 11, appId: 22 });
    const result = await f.service.saveFields({
      appId: 22,
      moduleId: "basic-info",
      changes: [
        { fieldId: "description", expected: null, value: "A test game" },
      ],
    });
    expect(result.saved).toEqual(["description"]);
    expect(result.unresolved).toEqual([]);
    expect(f.fields.title.current_value).toBe("Demo");
    const writes = f.calls.filter((args) => args[1] === "save-changes");
    expect(writes).toHaveLength(2);
    expect(writes[0]!.slice(0, -1)).toEqual(writes[1]!.slice(0, -1));
    expect(writes[1]!.at(-1)).toBe("--yes");
    expect(JSON.parse(writes[1]![writes[1]!.indexOf("--data") + 1]!)).toEqual({
      changes: [
        { field_id: "description", value: "A test game", expected: null },
      ],
    });
    expect(f.calls.at(-1)?.[1]).toBe("get-module");
  });
  it("refuses stale edits, a changed game, and non-editor fields without a write", async () => {
    const f = draftFixture();
    await f.service.select({ developerId: 11, appId: 22 });
    await expect(
      f.service.saveFields({
        appId: 22,
        moduleId: "basic-info",
        changes: [{ fieldId: "title", value: "New", expected: "Old" }],
      }),
    ).rejects.toThrow("changed remotely");
    await expect(
      f.service.saveFields({
        appId: 23,
        moduleId: "basic-info",
        changes: [{ fieldId: "title", value: "New", expected: "Demo" }],
      }),
    ).rejects.toThrow("selected game changed");
    await expect(
      f.service.saveFields({
        appId: 22,
        moduleId: "basic-info",
        changes: [{ fieldId: "age_grade", value: "18", expected: null }],
      }),
    ).rejects.toThrow("developer console");
    expect(f.calls.some((args) => args.includes("--yes"))).toBe(false);
  });
  it("reports partial saves from field readback, and does not resend the batch", async () => {
    const f = draftFixture();
    await f.service.select({ developerId: 11, appId: 22 });
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (args) => {
      if (args[1] === "save-changes" && args.includes("--yes")) {
        f.fields.title.current_value = "New";
        return ok({
          result: { updated_fields: ["title"], stale: ["description"] },
        });
      }
      return original(args);
    });
    const result = await f.service.saveFields({
      appId: 22,
      moduleId: "basic-info",
      changes: [
        { fieldId: "title", expected: "Demo", value: "New" },
        { fieldId: "description", expected: null, value: "Test" },
      ],
    });
    expect(result.saved).toEqual(["title"]);
    expect(result.unresolved).toEqual(["description"]);
    expect(
      f.run.mock.calls.filter(([args]) => args.includes("--yes")),
    ).toHaveLength(1);
  });
  it("binds a ready H5 version using the exact main snapshot and verifies the binding independently", async () => {
    const f = draftFixture();
    await f.service.select({ developerId: 11, appId: 22 });
    const result = await f.service.bind({
      appId: 22,
      packageId: "83",
      expected: { kind: "none" },
    });
    expect(result.packages.package_slots.main.expected).toEqual({
      kind: "h5",
      h5_version_id: "83",
    });
    await f.service.bind({
      appId: 22,
      packageId: "83",
      expected: { kind: "none" },
    });
    expect(f.calls.filter((args) => args.includes("--yes"))).toHaveLength(1);
    expect(f.calls.some((args) => /review|publish/.test(args[1]!))).toBe(false);
  });
  it("does not bind after a stale slot, missing draft or unavailable H5 capability", async () => {
    const f = draftFixture();
    await f.service.select({ developerId: 11, appId: 22 });
    f.setSlot({ kind: "h5", h5_version_id: "82" });
    await expect(
      f.service.bind({
        appId: 22,
        packageId: "83",
        expected: { kind: "none" },
      }),
    ).rejects.toThrow("changed remotely");
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation((args) =>
      args[1] === "list-versions"
        ? Promise.resolve(ok({ result: { list: [{ status: "reviewing" }] } }))
        : original(args),
    );
    await expect(
      f.service.bind({
        appId: 22,
        packageId: "83",
        expected: { kind: "h5", h5_version_id: "82" },
      }),
    ).rejects.toThrow("No editable draft");
    expect(f.calls.some((args) => args.includes("--yes"))).toBe(false);
  });
  it("allows declared H5 draft inspection but stops uploads when the declaration conflicts", async () => {
    const f = draftFixture();
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation((args) =>
      args[1] === "get-available-package-types"
        ? Promise.resolve(
            ok({
              result: {
                available_package_types: [],
                declared_package_types: ["h5"],
                empty_reason: "declared_not_applicable",
              },
            }),
          )
        : original(args),
    );
    await f.service.select({ developerId: 11, appId: 22 });
    await expect(
      f.service.prepare({ buildFolder: "dist", orientation: 0 }),
    ).rejects.toThrow("declaration conflicts");
    expect(f.calls.some((args) => args.includes("--yes"))).toBe(false);
  });
  it("reuses verified image receipts and saves the CLI metadata without inventing image information", async () => {
    const f = draftFixture();
    f.fields.icon = {
      field_id: "icon",
      input_type: "image",
      image_spec: {
        min_width: 512,
        min_height: 512,
        aspect_ratio: "1:1",
        formats: ["PNG"],
      },
    };
    await writeFile(path.join(workspace, "cover.png"), "local-image");
    const image = {
      url: "https://img-tc.tapimg.com/cover.png",
      info: {
        width: 512,
        height: 512,
        size: 100,
        format: "png",
        image_ave: { rgb: "0x123456" },
      },
    };
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation((args) =>
      args[0] === "upload" && args.includes("--yes")
        ? Promise.resolve(ok(image))
        : original(args),
    );
    await f.service.select({ developerId: 11, appId: 22 });
    expect(
      await f.service.uploadImage({ appId: 22, file: "cover.png" }),
    ).toEqual(image);
    expect(
      await f.service.uploadImage({ appId: 22, file: "cover.png" }),
    ).toEqual(image);
    expect(
      f.run.mock.calls.filter(
        ([args]) => args[0] === "upload" && args.includes("--yes"),
      ),
    ).toHaveLength(1);
    const saved = await f.service.saveFields({
      appId: 22,
      moduleId: "basic-info",
      changes: [{ fieldId: "icon", expected: null, value: image }],
    });
    expect(saved.saved).toEqual(["icon"]);
    expect(f.fields.icon.current_value).toEqual(image);
    await expect(
      f.service.saveFields({
        appId: 22,
        moduleId: "basic-info",
        changes: [
          {
            fieldId: "icon",
            expected: image,
            value: { ...image, url: "https://other.test/image.png" },
          },
        ],
      }),
    ).rejects.toThrow("Upload the image");
  });

  it("preserves an unknown image upload instead of starting another upload", async () => {
    const f = draftFixture();
    await writeFile(path.join(workspace, "cover.png"), "local-image");
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation((args) =>
      args[0] === "upload" && args.includes("--yes")
        ? Promise.reject(new Error("network interrupted"))
        : original(args),
    );
    await f.service.select({ developerId: 11, appId: 22 });
    await expect(
      f.service.uploadImage({ appId: 22, file: "cover.png" }),
    ).rejects.toThrow("network interrupted");
    await expect(
      f.service.uploadImage({ appId: 22, file: "cover.png" }),
    ).rejects.toThrow("unknown result");
    expect(
      f.run.mock.calls.filter(
        ([args]) => args[0] === "upload" && args.includes("--yes"),
      ),
    ).toHaveLength(1);
    await expect(
      f.service.uploadImage({ appId: 22, file: "../outside.png" }),
    ).rejects.toThrow();
  });

  it("does not turn image previews into arbitrary URL fetching", async () => {
    await expect(fetchStoreImage("https://localhost/secret")).rejects.toThrow(
      "official TapTap",
    );
    await expect(
      fetchStoreImage("https://img.tapimg.com.evil.test/image.png"),
    ).rejects.toThrow("official TapTap");
    await expect(
      fetchStoreImage("https://user:password@img.tapimg.com/image.png"),
    ).rejects.toThrow("official TapTap");
  });
});
