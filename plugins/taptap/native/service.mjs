import { discoverWorkspace, fetchStoreImage } from "./workspace.mjs";
import { isDeepStrictEqual } from "node:util";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
  realpath,
  stat,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { packageH5 } from "../skills/taptap-h5-publish/scripts/package-h5.mjs";

const redact = (text) =>
  String(text)
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(
      /((?:token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi,
      "$1[redacted]",
    );
const scope = (target) => [
  "--dev-id",
  String(target.developerId),
  "--app-id",
  String(target.appId),
];
const result = (response) => {
  if (response?.ok !== true)
    throw new Error(
      redact(
        response?.error?.message ?? "TapTap CLI returned no successful result",
      ),
    );
  return response.data;
};
const receipt = (data) =>
  Object.fromEntries(
    ["cliTaskId", "artifactId", "h5VersionId", "h5PackageId"]
      .filter((key) => data?.[key] !== undefined)
      .map((key) => [key, data[key]]),
  );
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// No shell interpolation, credentials or parallel upload implementation. The CLI
// owns auth, preflight, remote upload tasks and their recovery.
const running = new Set();
function stopTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).once("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  }
}
process.once("exit", () => {
  for (const child of running) stopTree(child);
});

export function cliRunner(executable, workspace, lifetime) {
  return (args) =>
    new Promise((resolve, reject) => {
      if (lifetime?.aborted) return reject(new Error("TapTap plugin stopped"));
      const child = spawn(executable, args, {
        cwd: workspace,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      running.add(child);
      const chunks = [];
      let bytes = 0;
      let failure;
      const stop = (message) => {
        failure = new Error(message);
        stopTree(child);
        reject(failure);
      };
      const abort = () =>
        stop("TapTap plugin stopped; upload outcome may be unknown");
      lifetime?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () =>
          stop(
            "TapTap CLI timed out; reconcile any pending upload before retrying",
          ),
        840000,
      );
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        lifetime?.removeEventListener("abort", abort);
        running.delete(child);
      };
      child.stdout.on("data", (chunk) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024)
          return stop(
            "TapTap CLI output exceeded its limit; reconcile any pending upload",
          );
        chunks.push(chunk);
      });
      // Never forward unstructured stderr, which may contain credentials.
      child.stderr.resume();
      child.once("error", (error) => {
        cleanup();
        reject(
          new Error(
            error.code === "ENOENT"
              ? "TapTap CLI was not found. Install it or set its executable path in plugin settings."
              : "TapTap CLI could not be started",
          ),
        );
      });
      child.once("close", () => {
        cleanup();
        if (failure) return;
        try {
          // A failed upload can still carry stable remote handles.
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(
            new Error(
              "TapTap CLI did not return JSON; reconcile any pending upload before retrying",
            ),
          );
        }
      });
    });
}

const validTarget = (value) =>
  value &&
  Number.isSafeInteger(value.developerId) &&
  value.developerId > 0 &&
  Number.isSafeInteger(value.appId) &&
  value.appId > 0 &&
  typeof value.title === "string";
const validArtifact = (value) =>
  value &&
  typeof value.id === "string" &&
  typeof value.path === "string" &&
  /^[a-f0-9]{64}$/.test(value.sha256) &&
  [0, 1].includes(value.orientation) &&
  validTarget(value.target);
function validState(value) {
  return (
    value?.version === 1 &&
    (!value.selection || validTarget(value.selection)) &&
    (!value.prepared ||
      (validArtifact(value.prepared) &&
        Array.isArray(value.prepared.warnings))) &&
    (!value.materials ||
      (Array.isArray(value.materials) &&
        value.materials.every(
          (item) =>
            validTarget(item.target) &&
            typeof item.sha256 === "string" &&
            ["unknown", "uploaded"].includes(item.state),
        ))) &&
    Array.isArray(value.uploads) &&
    value.uploads.every(
      (job) =>
        validArtifact(job) &&
        [
          "uploading",
          "unknown",
          "uploaded",
          "processing",
          "ready",
          "failed",
        ].includes(job.state),
    )
  );
}

export function createService({ workspace, directory, run }) {
  const stateFile = path.join(
    directory,
    `${createHash("sha256").update(workspace).digest("hex")}.json`,
  );
  let state;
  let loading;
  let busy = false;
  let uploading = false;
  const imageUrls = new Set();
  const rememberImages = (value) => {
    if (Array.isArray(value)) value.forEach(rememberImages);
    else if (value && typeof value === "object") {
      if (typeof value.url === "string") imageUrls.add(value.url);
      Object.values(value).forEach(rememberImages);
    }
    return value;
  };
  const load = () =>
    (loading ??= (async () => {
      try {
        state = JSON.parse(await readFile(stateFile, "utf8"));
        if (!validState(state))
          throw new Error(
            "Unsupported or damaged TapTap panel state; the file was preserved",
          );
        if (state.uploads.some((job) => job.state === "uploading")) {
          for (const job of state.uploads)
            if (job.state === "uploading") job.state = "unknown";
          await save();
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        state = { version: 1, uploads: [] };
      }
      for (const item of state.materials ?? [])
        if (item.image) rememberImages(item.image);
      return state;
    })());
  async function save() {
    await mkdir(directory, { recursive: true });
    const temporary = `${stateFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, stateFile);
  }
  const exclusive = async (work) => {
    if (busy)
      throw new Error("Another TapTap panel operation is still running");
    busy = true;
    try {
      await load();
      return await work();
    } finally {
      busy = false;
    }
  };
  const target = () => {
    if (!state.selection) throw new Error("Connect a TapTap game first");
    return state.selection;
  };
  const read = async (service, method, selected, data) => {
    const args = [
      service,
      method,
      ...(selected ? scope(selected) : []),
      ...(data ? ["--data", JSON.stringify(data)] : []),
    ];
    const value = result(await run(args));
    if (!value?.result || typeof value.result !== "object")
      throw new Error(`Unexpected TapTap CLI response for ${method}`);
    return rememberImages(value.result);
  };
  async function available(selected) {
    const value = await read(
      "package-management",
      "get-available-package-types",
      selected,
    );
    if (!value.available_package_types?.includes("h5"))
      throw new Error(
        value.empty_reason === "declared_not_applicable"
          ? "The saved H5 declaration conflicts with this game’s current form. Use package-type diagnosis; do not change its type or retry the upload."
          : "This TapTap game does not currently accept H5 packages. Check its package capabilities before uploading.",
      );
  }
  const fieldsByModule = {
    "basic-info": [
      "title",
      "description",
      "category",
      "promotion_text",
      "title_ios",
      "description_ios",
      "icon",
      "icon_ios",
    ],
    "assets-upload": [
      "banner_4",
      "square_promo_image",
      "screenshots",
      "banner_4_ios",
      "square_promo_image_ios",
      "screenshots_ios",
    ],
    "developer-info": ["developer_message"],
  };
  async function editable(selected) {
    const versions = await read("app", "list-versions", selected, {
      page: 1,
      page_size: 100,
    });
    const draft = versions.list?.find((item) => item.status === "draft");
    if (!draft)
      throw new Error(
        "No editable draft. Create a draft in the developer console before saving; a review or scheduled release will not be cancelled.",
      );
    return draft;
  }
  async function write(method, selected, payload) {
    const id = randomUUID();
    const args = [
      "app",
      method,
      ...scope(selected),
      "--data",
      JSON.stringify(payload),
      "--idempotency-key",
      id,
    ];
    result(await run([...args, "--dry-run"]));
    state.lastMutation = {
      id,
      method,
      target: selected,
      payload,
      state: "pending",
      startedAt: new Date().toISOString(),
    };
    await save();
    try {
      const value = result(await run([...args, "--yes"]));
      state.lastMutation.state = "written";
      await save();
      return value.result;
    } catch (error) {
      state.lastMutation.state = "unknown";
      state.lastMutation.error = error.message;
      await save();
      throw error;
    }
  }
  return {
    discover: () => discoverWorkspace(workspace),
    async image({ url }) {
      if (!imageUrls.has(url))
        throw new Error(
          "Read the selected game's image field before requesting its preview",
        );
      return fetchStoreImage(url);
    },
    async capabilities() {
      await load();
      const selected = target();
      const capabilities = await read(
        "package-management",
        "get-available-package-types",
        selected,
      );
      let diagnosis;
      if (capabilities.empty_reason === "declared_not_applicable")
        diagnosis = result(
          await run([
            "package-management",
            "diagnose-package-type",
            ...scope(selected),
            "--json",
          ]),
        );
      return { ...capabilities, diagnosis };
    },
    uploadImage({ file, appId }) {
      return exclusive(async () => {
        const selected = target();
        if (selected.appId !== appId)
          throw new Error("The selected game changed");
        const root = await realpath(workspace);
        const absolute = await realpath(path.resolve(root, file));
        const relative = path.relative(root, absolute);
        if (
          relative.startsWith("..") ||
          path.isAbsolute(relative) ||
          !/\.(png|jpe?g|webp)$/i.test(relative)
        )
          throw new Error(
            "Choose a PNG, JPEG or WebP image inside this project",
          );
        if ((await stat(absolute)).size > 20 * 1024 * 1024)
          throw new Error("Image exceeds the 20 MB local upload limit");
        const sha256 = await digest(absolute);
        state.materials ??= [];
        const previous = state.materials.find(
          (item) =>
            item.target.appId === appId &&
            item.target.developerId === selected.developerId &&
            item.sha256 === sha256,
        );
        if (previous?.image) return previous.image;
        if (previous)
          throw new Error(
            "This image upload has an unknown result. Reconcile its CLI task before uploading it again.",
          );
        const id = randomUUID();
        const args = [
          "upload",
          relative,
          ...scope(selected),
          "--idempotency-key",
          id,
        ];
        result(await run([...args, "--dry-run"]));
        const job = {
          id,
          target: selected,
          path: relative,
          sha256,
          state: "unknown",
        };
        state.materials.push(job);
        await save();
        try {
          const value = result(await run([...args, "--yes"]));
          const info = value.info;
          if (
            !value.url?.startsWith("https://") ||
            !info?.width ||
            !info?.height ||
            !info?.size ||
            !info?.format ||
            !/^0x[0-9a-f]{6}$/i.test(info.image_ave?.rgb)
          )
            throw new Error(
              "Image upload returned incomplete metadata; inspect the existing CLI task",
            );
          job.image = { url: value.url, info };
          job.state = "uploaded";
          rememberImages(job.image);
          await save();
          return job.image;
        } catch (error) {
          job.error = error.message;
          await save();
          throw error;
        }
      });
    },
    saveFields({ moduleId, changes, appId }) {
      return exclusive(async () => {
        const selected = target();
        if (selected.appId !== appId)
          throw new Error(
            "The selected game changed. Reload its fields before saving.",
          );
        await editable(selected);
        const current = await read("app", "get-module", selected, {
          module_id: moduleId,
        });
        if (
          !Array.isArray(changes) ||
          !changes.length ||
          changes.length > 10 ||
          new Set(changes.map((c) => c.fieldId)).size !== changes.length
        )
          throw new Error("Choose between 1 and 10 different fields to save");
        const payload = changes
          .map((change) => {
            const field = current.fields?.[change.fieldId];
            if (
              !fieldsByModule[moduleId]?.includes(change.fieldId) ||
              !field ||
              !["text", "textarea", "select", "image", "image_array"].includes(
                field.input_type,
              ) ||
              field.state === "readonly"
            )
              throw new Error(
                "This field must be edited in the developer console",
              );
            if (
              !Object.hasOwn(change, "expected") ||
              !isDeepStrictEqual(field.current_value ?? null, change.expected)
            )
              throw new Error(
                `The field ${field.label || change.fieldId} changed remotely. Reload and compare before saving.`,
              );
            if (["image", "image_array"].includes(field.input_type)) {
              const items =
                field.input_type === "image_array"
                  ? change.value
                  : [change.value];
              if (!Array.isArray(items)) throw new Error("Image list required");
              const existing = Array.isArray(field.current_value)
                ? field.current_value
                : [field.current_value];
              for (const item of items) {
                if (existing.some((value) => isDeepStrictEqual(value, item)))
                  continue;
                if (
                  !state.materials?.some(
                    (value) =>
                      value.target.appId === selected.appId &&
                      value.target.developerId === selected.developerId &&
                      isDeepStrictEqual(value.image, item),
                  )
                )
                  throw new Error(
                    "Upload the image through this panel before saving it",
                  );
                const spec = field.image_spec ?? {},
                  info = item.info;
                if (
                  spec.formats &&
                  !spec.formats
                    .map((f) => f.toLowerCase().replace("jpeg", "jpg"))
                    .includes(info.format.toLowerCase().replace("jpeg", "jpg"))
                )
                  throw new Error(
                    "Image format does not meet this field's requirements",
                  );
                if (
                  info.width < (spec.min_width ?? 0) ||
                  info.height < (spec.min_height ?? 0) ||
                  info.width > (spec.max_width ?? Infinity) ||
                  info.height > (spec.max_height ?? Infinity)
                )
                  throw new Error(
                    "Image dimensions do not meet this field's requirements",
                  );
                const ratio = spec.aspect_ratio?.match(/^(\d+):(\d+)$/);
                if (
                  ratio &&
                  info.width * Number(ratio[2]) !==
                    info.height * Number(ratio[1])
                )
                  throw new Error(
                    "Image aspect ratio does not meet this field's requirements",
                  );
              }
            } else {
              if (typeof change.value !== "string")
                throw new Error("Text field values must be strings");
              if (field.options && !field.options.includes(change.value))
                throw new Error("Choose a current field option");
              if (
                field.constraints?.max_length &&
                [...change.value].length > field.constraints.max_length
              )
                throw new Error("Field exceeds its current length limit");
            }
            return {
              field_id: change.fieldId,
              value: change.value,
              expected: change.expected,
              ...(field.input_type === "image_array" ? { op: "replace" } : {}),
            };
          })
          .filter(
            (change) => !isDeepStrictEqual(change.value, change.expected),
          );
        if (!payload.length)
          return {
            module: current,
            saved: changes.map((c) => c.fieldId),
            unresolved: [],
          };
        let error;
        try {
          await write("save-changes", selected, { changes: payload });
        } catch (failure) {
          error = failure.message;
        }
        const updated = await read("app", "get-module", selected, {
          module_id: moduleId,
        });
        const saved = changes
          .filter((change) =>
            isDeepStrictEqual(
              updated.fields?.[change.fieldId]?.current_value,
              change.value,
            ),
          )
          .map((c) => c.fieldId);
        if (saved.includes("title"))
          state.selection.title = updated.fields.title.current_value;
        const unresolved = changes
          .filter((change) => !saved.includes(change.fieldId))
          .map((c) => c.fieldId);
        if (state.lastMutation) {
          state.lastMutation.state = unresolved.length ? "partial" : "verified";
          await save();
        }
        return { module: updated, saved, unresolved, error };
      });
    },
    bind({ packageId, expected, appId }) {
      return exclusive(async () => {
        const selected = target();
        if (selected.appId !== appId)
          throw new Error("The selected game changed. Refresh before binding.");
        await available(selected);
        await editable(selected);
        const packages = await read("app", "list-packages", selected, {
          package_types: ["h5"],
        });
        const slot = packages.package_slots?.main;
        if (!slot?.available || !slot.expected)
          throw new Error(
            "The current draft has no available main slot snapshot",
          );
        if (
          slot.expected.kind === "h5" &&
          slot.expected.h5_version_id === packageId
        )
          return { packages, alreadyBound: true };
        if (!isDeepStrictEqual(slot.expected, expected))
          throw new Error(
            "The main package changed remotely. Refresh before binding.",
          );
        if (
          !packages.list?.some(
            (item) =>
              item.type === "h5" &&
              item.status === "ready" &&
              item.package_id === packageId,
          )
        )
          throw new Error("This package is no longer a ready H5 candidate");
        let error;
        try {
          await write("select-package", selected, {
            slot: "main",
            package: { type: "h5", id: packageId },
            expected: slot.expected,
          });
        } catch (failure) {
          error = failure.message;
        }
        const updated = await read("app", "list-packages", selected, {
          package_types: ["h5"],
        });
        const bound = updated.package_slots?.main?.expected;
        if (bound?.kind !== "h5" || bound.h5_version_id !== packageId)
          throw new Error(
            error ||
              "The package binding could not be confirmed. Refresh before trying again.",
          );
        state.lastMutation.state = "verified";
        await save();
        return { packages: updated, error };
      });
    },
    async status() {
      await load();
      let cli;
      try {
        const version = result(await run(["version"]));
        if (version.contract !== "3")
          throw new Error(
            "This TapTap panel requires CLI contract 3. Check the installed CLI version.",
          );
        const auth = result(
          await run(["auth", "status", "--offline", "--json"]),
        );
        cli = {
          version: version.version,
          signedIn:
            auth.hasAccessToken === true && auth.accessTokenExpired !== true,
        };
      } catch (error) {
        cli = { error: error.message };
      }
      return { ...state, cli, busy, uploading };
    },
    async developers() {
      return read("developer", "list-developers");
    },
    async apps({ developerId, page = 1, keyword = "" }) {
      return result(
        await run([
          "developer",
          "list-apps",
          "--dev-id",
          String(developerId),
          "--data",
          JSON.stringify({ page, page_size: 50, keyword }),
        ]),
      ).result;
    },
    select(input) {
      return exclusive(async () => {
        if (
          state.uploads.some((job) =>
            ["uploading", "unknown"].includes(job.state),
          )
        )
          throw new Error(
            "Reconcile the previous upload before switching games",
          );
        const capabilities = await read(
          "package-management",
          "get-available-package-types",
          input,
        );
        if (
          ![
            ...(capabilities.available_package_types ?? []),
            ...(capabilities.declared_package_types ?? []),
          ].includes("h5")
        )
          throw new Error(
            "This game is not declared for H5. Keep its existing package type and select an H5 game.",
          );
        imageUrls.clear();
        const basic = await read("app", "get-module", input, {
          module_id: "basic-info",
        });
        state.selection = {
          developerId: input.developerId,
          appId: input.appId,
          title: basic.fields?.title?.current_value ?? String(input.appId),
        };
        delete state.prepared;
        await save();
        return state.selection;
      });
    },
    async overview({ page = 1 } = {}) {
      await load();
      const selected = target();
      const queries = {
        analysis: ["app", "analyze-status"],
        versions: ["app", "list-versions", { page, page_size: 20 }],
        packages: ["app", "list-packages", { package_types: ["h5"] }],
      };
      const results = await Promise.all(
        Object.entries(queries).map(async ([key, [service, method, data]]) => {
          try {
            return [key, { data: await read(service, method, selected, data) }];
          } catch (error) {
            return [key, { error: error.message }];
          }
        }),
      );
      return { selection: selected, ...Object.fromEntries(results) };
    },
    async module({ moduleId }) {
      await load();
      if (
        ![
          "basic-info",
          "assets-upload",
          "developer-info",
          "platform-status",
          "release-settings",
          "profile-promotion",
        ].includes(moduleId)
      )
        throw new Error("Unsupported store page module");
      return read("app", "get-module", target(), { module_id: moduleId });
    },
    prepare({ buildFolder, orientation }) {
      return exclusive(async () => {
        if (
          state.uploads.some((job) =>
            ["unknown", "uploading"].includes(job.state),
          )
        )
          throw new Error(
            "Reconcile the previous upload before preparing another package",
          );
        const selected = target();
        delete state.prepared;
        await save();
        await available(selected);
        const folder = path.join(workspace, ".ohmygame", "local", "taptap");
        await mkdir(folder, { recursive: true });
        const id = randomUUID();
        const artifact = await packageH5(
          buildFolder,
          path.join(folder, `${id}.zip`),
          workspace,
        );
        const relative = path.relative(workspace, artifact.path);
        const preview = result(
          await run([
            "upload-h5-package",
            relative,
            ...scope(selected),
            "--screen-orientation",
            String(orientation),
            "--idempotency-key",
            id,
            "--dry-run",
          ]),
        );
        const preflight = preview.archive_preflight;
        if (
          !preflight ||
          !Array.isArray(preflight.violations) ||
          preflight.violations.length ||
          preflight.top_level_entries?.length !== 1 ||
          preflight.top_level_entries[0] !== "game"
        )
          throw new Error(
            "H5 archive preflight did not pass; no upload started",
          );
        state.prepared = {
          ...artifact,
          id,
          target: selected,
          orientation,
          buildFolder,
          preflight,
        };
        await save();
        return state.prepared;
      });
    },
    upload({ preparedId }) {
      return exclusive(async () => {
        const prepared = state.prepared;
        if (!prepared || prepared.id !== preparedId)
          throw new Error("Prepare and review the current package first");
        if (state.uploads.some((job) => job.id === preparedId))
          throw new Error(
            "This upload was already started. Check its result instead of uploading again.",
          );
        if ((await digest(prepared.path)) !== prepared.sha256)
          throw new Error("ZIP changed since preflight. Prepare it again.");
        await available(prepared.target);
        const job = {
          id: prepared.id,
          target: prepared.target,
          path: prepared.path,
          sha256: prepared.sha256,
          orientation: prepared.orientation,
          state: "uploading",
          startedAt: new Date().toISOString(),
        };
        state.uploads.push(job);
        await save(); // Durable intent before any remote write.
        uploading = true;
        try {
          const response = await run([
            "upload-h5-package",
            path.relative(workspace, prepared.path),
            ...scope(prepared.target),
            "--screen-orientation",
            String(prepared.orientation),
            "--idempotency-key",
            prepared.id,
            "--yes",
          ]);
          job.receipt = receipt(response.data);
          job.state =
            response.ok === true
              ? response.data?.readbackErrors?.length || !job.receipt.artifactId
                ? "unknown"
                : "uploaded"
              : "unknown";
          if (response.ok !== true)
            job.error = redact(
              response.error?.message ??
                "Upload outcome could not be confirmed",
            );
          if (response.data?.readbackErrors?.length)
            job.error =
              "Upload readback was incomplete; reconcile the existing receipt before continuing";
        } catch (error) {
          job.state = "unknown";
          job.error = error.message;
        } finally {
          uploading = false;
        }
        await save();
        return job;
      });
    },
    reconcile({ uploadId, artifactId }) {
      return exclusive(async () => {
        const job = state.uploads.find((item) => item.id === uploadId);
        if (!job) throw new Error("Upload record not found");
        let handle = job.receipt?.artifactId;
        if (!handle && job.receipt?.cliTaskId) {
          const task = result(
            await run(["task", "+get", String(job.receipt.cliTaskId)]),
          );
          handle = task.external?.artifactId;
        }
        handle ??= artifactId;
        const recovered = !job.receipt?.artifactId;
        if (!handle)
          throw new Error(
            "Upload outcome is unknown. Use the CLI task history to reconcile this intent before starting another upload.",
          );
        const parsed = await read(
          "package-management",
          "get-h5-package-upload-status",
          job.target,
          { artifact_id: handle },
        );
        if (recovered && parsed.file_name !== path.basename(job.path))
          throw new Error(
            "The artifact filename does not match this upload intent; record preserved",
          );
        if (!["ready", "processing", "failed"].includes(parsed.status))
          throw new Error("Unknown H5 parsing status; upload record preserved");
        job.receipt = { ...job.receipt, artifactId: handle };
        job.state = parsed.status;
        job.error = parsed.error ?? undefined;
        if (parsed.package_id) job.receipt.h5PackageId = parsed.package_id;
        await save();
        return job;
      });
    },
  };
}
