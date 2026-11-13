import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const API = "https://api.pixellab.ai/v2";
const WAIT_MS = 2_000;
const LIMIT_MS = 8 * 60_000;

export function activate(context) {
  context.registerCommand("pixen", (input, call) => pixen(input, call));
  context.registerCommand("createCharacter", (input, call) => createCharacter(input, call));
  context.registerCommand("skeletonAnimation", (input, call) => skeletonAnimation(input, call));
}

async function pixen({ params, output }, call) {
  const response = await request(call, "/create-image-pixen", {
    description: required(params.description, "Description"),
    image_size: { width: 128, height: 128 },
    no_background: params.transparent === true,
  });
  const base64 = response.image?.base64;
  if (typeof base64 !== "string") throw new Error("PixelLab returned no image");
  const file = "pixen.png";
  await writeFile(path.join(output, file), Buffer.from(base64.replace(/^data:image\/[^;]+;base64,/, ""), "base64"));
  return { file };
}

async function createCharacter({ params, inputs, output }, call) {
  const character = await create(call, params, inputs.reference?.[0]);
  await waitForJob(call, character.background_job_id, "character");
  return exportGif(call, character.character_id, output, "character.gif");
}

async function skeletonAnimation({ params, inputs, output }, call) {
  const character = await create(call, params, inputs.reference?.[0]);
  await waitForJob(call, character.background_job_id, "character");
  const animation = await request(call, "/characters/animations", {
    character_id: character.character_id,
    description: required(params.description, "Description"),
    action_description: required(params.action, "Action"),
    mode: "skeleton-v3",
    directions: [params.direction],
  });
  const job = animation.background_job_ids?.[0];
  if (typeof job !== "string" || typeof animation.animation_group_id !== "string") throw new Error("PixelLab returned no animation job");
  await waitForJob(call, job, "animation");
  return exportGif(call, character.character_id, output, "animation.gif", animation.animation_group_id, params.direction);
}

async function create(call, params, reference) {
  const description = required(params.description, "Description");
  const body = params.body || "mannequin";
  const payload = { description, template_id: body, n_directions: Number(params.directions || 8), no_background: true };
  if (!reference) return request(call, "/create-character-v3", payload);
  const content = await readBase64(reference.path);
  return request(call, "/create-character-v3", { ...payload, reference_image: { base64: `data:${reference.contentType};base64,${content}` } });
}

async function exportGif(call, characterId, output, filename, animationGroupId, direction) {
  const query = new URLSearchParams();
  if (animationGroupId) query.set("animation_group_id", animationGroupId);
  if (direction) query.set("direction", direction);
  const response = await fetch(`${API}/characters/${encodeURIComponent(characterId)}/gif${query.size ? `?${query}` : ""}`, { headers: headers(call), signal: call.signal });
  if (!response.ok) throw await failure(response);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error("PixelLab returned an empty GIF");
  await writeFile(path.join(output, filename), bytes);
  return { file: filename };
}

async function waitForJob(call, jobId, label) {
  if (typeof jobId !== "string") throw new Error(`PixelLab returned no ${label} job`);
  const deadline = Date.now() + LIMIT_MS;
  while (Date.now() < deadline) {
    await delay(WAIT_MS, call.signal);
    const response = await fetch(`${API}/background-jobs/${encodeURIComponent(jobId)}`, { headers: headers(call), signal: call.signal });
    if (!response.ok) throw await failure(response);
    const job = await response.json();
    if (job.status === "completed") return job;
    if (job.status === "failed" || job.status === "cancelled") throw new Error(`PixelLab ${label} failed: ${detail(job.last_response)}`);
  }
  throw new Error(`PixelLab ${label} timed out`);
}

async function request(call, route, body) {
  const response = await fetch(`${API}${route}`, { method: "POST", headers: { ...headers(call), "content-type": "application/json" }, body: JSON.stringify(body), signal: call.signal });
  if (!response.ok) throw await failure(response);
  return response.json();
}

function headers(call) {
  const key = call.configuration.apiKey;
  if (typeof key !== "string" || !key.trim()) throw new Error("Set the PixelLab API key in the plugin settings first");
  return { authorization: `Bearer ${key.trim()}` };
}

async function readBase64(file) { return readFile(file, "base64"); }
function required(value, name) { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`); return value.trim(); }
function detail(value) { return typeof value?.detail === "string" ? value.detail : "unknown error"; }
async function failure(response) { const body = await response.json().catch(() => ({})); return new Error(`PixelLab ${response.status}: ${detail(body)}`); }
function delay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("PixelLab request cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() { signal?.removeEventListener("abort", cancelled); resolve(); }
    function cancelled() { clearTimeout(timer); signal?.removeEventListener("abort", cancelled); reject(signal.reason ?? new Error("PixelLab request cancelled")); }
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}
