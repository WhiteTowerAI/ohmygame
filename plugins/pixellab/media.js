const API = "https://api.pixellab.ai/v2";

// PixelLab's image endpoints are represented as ordinary image-provider
// models. This adapter only passes the model request through: it does not
// compose sheets, infer poses, or reinterpret the person's action prompt.
export default {
  image: {
    async start(input, host) {
      if (input.model === "pixen") {
        const response = await host.fetch(`${API}/create-image-pixen`, {
          method: "POST", auth: true,
          json: { description: input.prompt, image_size: size(input.resolution), no_background: input.transparentBackground === true },
        });
        if (!response.ok) return { error: await detail(response) };
        const image = (await response.json()).image?.base64;
        return typeof image === "string" ? { outputs: [{ base64: withoutDataUrl(image), mediaType: "image/png" }] } : { error: "PixelLab returned no image" };
      }
      if (input.model === "create-character") return createCharacter(input, host);
      if (input.model === "skeleton-animation") return startAnimation(input, host);
      return { error: "Unknown PixelLab image model" };
    },
    async check(task, host) {
      if (task.phase === "character") {
        const job = await status(task.jobId, host);
        if (job.error) return job;
        if (!job.done) return { task, retryAfter: 2 };
        if (task.mode === "character") return gif(task.characterId, {});
        const started = await host.fetch(`${API}/characters/animations`, {
          method: "POST", auth: true,
          json: { character_id: task.characterId, description: "pixel art character", action_description: task.action, mode: "skeleton-v3", directions: ["south"] },
        });
        if (!started.ok) return { error: await detail(started) };
        const animation = await started.json();
        const jobId = animation.background_job_ids?.[0];
        if (typeof jobId !== "string" || typeof animation.animation_group_id !== "string") return { error: "PixelLab returned no animation job" };
        return { task: { phase: "animation", characterId: task.characterId, jobId, animationGroupId: animation.animation_group_id }, retryAfter: 2 };
      }
      if (task.phase === "animation") {
        const job = await status(task.jobId, host);
        if (job.error) return job;
        if (!job.done) return { task, retryAfter: 2 };
        return gif(task.characterId, { animation_group_id: task.animationGroupId, direction: "south" });
      }
      return { error: "Unknown PixelLab task" };
    },
  },
};

async function createCharacter(input, host) {
  const response = await host.fetch(`${API}/create-character-v3`, {
    method: "POST", auth: true,
    json: { ...characterRequest(input), ...referenceImage(input) },
  });
  if (!response.ok) return { error: await detail(response) };
  const character = await response.json();
  return validCharacter(character)
    ? { task: { phase: "character", mode: "character", characterId: character.character_id, jobId: character.background_job_id }, retryAfter: 2 }
    : { error: "PixelLab returned no character job" };
}

async function startAnimation(input, host) {
  const reference = input.references?.[0];
  if (!reference?.base64 || !reference?.mediaType) return { error: "Skeleton Animation requires one reference image" };
  const response = await host.fetch(`${API}/create-character-v3`, {
    method: "POST", auth: true,
    json: { ...characterRequest(input), ...referenceImage(input) },
  });
  if (!response.ok) return { error: await detail(response) };
  const character = await response.json();
  return validCharacter(character)
    ? { task: { phase: "character", mode: "animation", characterId: character.character_id, jobId: character.background_job_id, action: input.prompt }, retryAfter: 2 }
    : { error: "PixelLab returned no character job" };
}
function characterRequest(input) {
  return { description: input.prompt, template_id: "mannequin", n_directions: 8, no_background: true };
}
function referenceImage(input) {
  const reference = input.references?.[0];
  return reference?.base64 && reference.mediaType ? { reference_image: { base64: `data:${reference.mediaType};base64,${reference.base64}` } } : {};
}
function size(resolution) {
  const side = Number.parseInt(resolution, 10);
  return { width: Number.isFinite(side) ? side : 128, height: Number.isFinite(side) ? side : 128 };
}
function validCharacter(value) { return typeof value?.character_id === "string" && typeof value?.background_job_id === "string"; }
async function status(jobId, host) {
  const response = await host.fetch(`${API}/background-jobs/${encodeURIComponent(jobId)}`, { auth: true });
  if (!response.ok) return { error: await detail(response) };
  const job = await response.json();
  if (job.status === "completed") return { done: true };
  if (job.status === "failed" || job.status === "cancelled") return { error: `PixelLab job failed: ${typeof job.last_response?.detail === "string" ? job.last_response.detail : "unknown error"}` };
  return { done: false };
}
async function gif(characterId, query) {
  const pairs = Object.entries(query).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  return { outputs: [{ url: `${API}/characters/${encodeURIComponent(characterId)}/gif${pairs.length ? `?${pairs.join("&")}` : ""}` }] };
}
async function detail(response) {
  const body = await response.json().catch(() => ({}));
  return `PixelLab ${response.status}: ${typeof body.detail === "string" ? body.detail : "request failed"}`;
}
function withoutDataUrl(value) { return value.replace(/^data:image\/[^;]+;base64,/, ""); }
