import { Bookmark, Box, ChevronDown, ChevronRight, Download, Film, FolderInput, Image, LoaderCircle, MoreHorizontal, Music2, Play, Plus, RefreshCw, Sparkles, Trash2, Upload, X } from "./icons.js";
import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type DragEvent as ReactDragEvent, type FormEvent, type ReactNode } from "react";
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_OUTPUT_COUNTS,
  IMAGE_RESOLUTIONS,
  MODEL_3D_POSES,
  MODEL_3D_QUALITIES,
  MODEL_3D_TEXTURE_RESOLUTIONS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_MODEL,
  VIDEO_RESOLUTIONS,
  type ImageAspectRatio,
  type ImageModel,
  type ImageOutputCount,
  type ImageResolution,
  type Model3DModel,
  type Model3DPose,
  type Model3DQuality,
  type Model3DTextureResolution,
  type ProjectState,
  type LibraryAsset,
  type PromptImage,
  type ToolRun,
  type ToolJob,
  type VideoAspectRatio,
  type VideoGenerationReference,
  type VideoResolution,
} from "../shared/contracts.js";
import { addToolResultToProject, cancelToolJob, createAssetTemplate, deleteAssetTemplate, getAssetStudioDraft, getAssetTemplateCover, getExploreTemplateCover, getImageGenerationSettings, getToolRunFile, listAssetTemplates, listExploreTemplates, listImageModels, listLibraryAssets, listProjects, listToolJobs, listToolRuns, MODELS_CHANGED_EVENT, publishAssetTemplate, recordCommunityUse, retryToolJob, setAssetTemplateCover, setAssetTemplatePublicationStatus, startToolJob, updateAssetStudioDraft, updateImageGenerationSettings, uploadLibraryAsset, waitForRuntime } from "./api.js";
import { STUDIO_PROMPT_PLACEHOLDERS, type AssetTemplate, type Model3DSource, type StudioMode } from "./asset-templates.js";
import type { ExploreAssetTemplate, LocalAssetTemplate } from "../shared/asset-templates.js";
import type { AssetStudioDraft } from "../shared/asset-studio-draft.js";
import { AppSidebar } from "./app-sidebar.js";
import { useAuth } from "./auth.js";
import type { AppNavigationTarget, SidebarPage } from "./routes.js";
import { ModelPreview } from "./model-preview.js";
import { WindowDragRegion } from "./window-drag-region.js";
import { CommunityMeta } from "./community-meta.js";
import { imageToWebP } from "./image.js";
import { AssetCardShell, AssetDialogShell, AssetMedia, useNearViewport } from "./asset-gallery.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { prepareVideoReferenceFile, validateVideoReferenceCounts, validateVideoReferenceDurations, validVideoReferenceCombination, VIDEO_REFERENCE_ACCEPT } from "./video-reference-files.js";

interface AssetStudioPageProps {
  onNavigate: (page: AppNavigationTarget) => void;
}

const VIDEO_MODEL_OPTIONS = [{ value: VIDEO_MODEL, label: "Seedance 2.0" }] as const;
const MODEL_3D_OPTIONS = [
  { value: "meshy-7", label: "Meshy 7 - High detail" },
  { value: "meshy-t2", label: "Meshy T2 - Game-ready" },
] as const;
const HISTORY_LIMIT = 20;
const MODEL_3D_SOURCE_OPTIONS = [
  { value: "image", label: "Image" },
  { value: "text", label: "Text" },
] as const;
interface PreviewResult {
  run: ToolRun;
  urls: string[];
  title: string;
}

type AssetPanelView = "templates" | "history";

export function AssetStudioPage({ onNavigate }: AssetStudioPageProps) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string>();
  const [mode, setMode] = useState<StudioMode>("image");
  const [templateIds, setTemplateIds] = useState<Partial<Record<StudioMode, string>>>({});
  const [imagePhase, setImagePhase] = useState<"loading" | "ready" | "error">("loading");
  const [imageLoadError, setImageLoadError] = useState<string>();
  const [imageModels, setImageModels] = useState<ImageModel[]>([]);
  const [imageModelKey, setImageModelKey] = useState("");
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageReferences, setImageReferences] = useState<PromptImage[]>([]);
  const [imageReferenceNames, setImageReferenceNames] = useState<string[]>([]);
  const [resolution, setResolution] = useState<ImageResolution>("1K");
  const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>("1:1");
  const [outputs, setOutputs] = useState<ImageOutputCount>(1);
  const [videoPrompt, setVideoPrompt] = useState("");
  const [videoReferences, setVideoReferences] = useState<VideoGenerationReference[]>([]);
  const [libraryAssets, setLibraryAssets] = useState<LibraryAsset[]>([]);
  const [videoAspectRatio, setVideoAspectRatio] = useState<VideoAspectRatio>("adaptive");
  const [videoResolution, setVideoResolution] = useState<VideoResolution>("720p");
  const [videoDuration, setVideoDuration] = useState(6);
  const [model3D, setModel3D] = useState<Model3DModel>(MODEL_3D_OPTIONS[0].value);
  const [model3DSource, setModel3DSource] = useState<Model3DSource>("image");
  const [model3DPrompt, setModel3DPrompt] = useState("");
  const [modelReferences, setModelReferences] = useState<(PromptImage | undefined)[]>([]);
  const [modelReferenceNames, setModelReferenceNames] = useState<(string | undefined)[]>([]);
  const [model3DMultiView, setModel3DMultiView] = useState(false);
  const [model3DQuality, setModel3DQuality] = useState<Model3DQuality>("standard");
  const [model3DTargetPolycount, setModel3DTargetPolycount] = useState(4_000);
  const [model3DTexture, setModel3DTexture] = useState(true);
  const [model3DTextureResolution, setModel3DTextureResolution] = useState<Model3DTextureResolution>("2K");
  const [model3DPbr, setModel3DPbr] = useState(false);
  const [model3DPose, setModel3DPose] = useState<Model3DPose>("auto");
  const [model3DImageEnhancement, setModel3DImageEnhancement] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<ToolJob[]>([]);
  const [jobActions, setJobActions] = useState<Set<string>>(() => new Set());
  const [uploadingReferences, setUploadingReferences] = useState(false);
  const [result, setResult] = useState<PreviewResult>();
  const [history, setHistory] = useState<PreviewResult[]>([]);
  const [historyDetailOpen, setHistoryDetailOpen] = useState(false);
  const [panelView, setPanelView] = useState<AssetPanelView>("templates");
  const [localTemplates, setLocalTemplates] = useState<LocalAssetTemplate[]>([]);
  const [exploreTemplates, setExploreTemplates] = useState<ExploreAssetTemplate[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");
  const [templateCover, setTemplateCover] = useState<Blob>();
  const [templateCoverUrl, setTemplateCoverUrl] = useState<string>();
  const [templateCoverBusy, setTemplateCoverBusy] = useState(false);
  const [templateDialogError, setTemplateDialogError] = useState<string>();
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [selectedResult, setSelectedResult] = useState(0);
  const [generationError, setGenerationError] = useState<string>();
  const [referenceError, setReferenceError] = useState<string>();
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [projectsError, setProjectsError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [actionStatus, setActionStatus] = useState<{ type: "success" | "error"; message: string }>();
  const mounted = useRef(true);
  const draftReady = useRef(false);
  const draftSaveTimer = useRef<number | undefined>(undefined);
  const latestDraft = useRef<AssetStudioDraft | undefined>(undefined);
  const pendingSelection = useRef<{ runId?: string; output?: number }>({});
  const historyRef = useRef<PreviewResult[]>([]);
  const hydratingJobs = useRef(new Set<string>());
  const templateCoverRequest = useRef(0);
  const templateCoverUrlRef = useRef<string | undefined>(undefined);
  const uploadInput = useRef<HTMLInputElement>(null);
  const modelReferenceTarget = useRef(0);
  const resultActions = useRef<HTMLDivElement>(null);
  const auth = useAuth();

  const yoursTemplates = localTemplates.map(templateForGallery);
  const communityTemplates = exploreTemplates.map(templateForGallery);
  const templates = [...yoursTemplates, ...communityTemplates];
  const selectedTemplate = templates.find((template) => template.id === templateIds[mode] && template.mode === mode);
  const promptPlaceholder = selectedTemplate?.promptPlaceholder ?? STUDIO_PROMPT_PLACEHOLDERS[mode];
  const selectedImageModel = imageModels.find((model) => modelKey(model) === imageModelKey);
  const supportedImageResolutions = IMAGE_RESOLUTIONS.filter((candidate) =>
    selectedImageModel?.generationOptions.some((option) => option.resolution === candidate),
  );
  const supportedImageAspectRatios = IMAGE_ASPECT_RATIOS.filter((candidate) =>
    selectedImageModel?.generationOptions.some((option) => option.resolution === resolution && option.aspectRatio === candidate),
  );
  const selectedFile = result?.run.files[selectedResult];
  const selectedUrl = result?.urls[selectedResult];
  const isMeshyT2 = model3D === "meshy-t2";
  const videoReferenceError = videoReferences.some((reference) => reference.type === "audio") && !validVideoReferenceCombination(videoReferences)
    ? "Add an image or video to use an audio reference"
    : undefined;
  const canGenerate = mode === "image"
    ? Boolean(imagePrompt.trim() && selectedImageModel)
    : mode === "video"
      ? Boolean(videoPrompt.trim() && validVideoReferenceCombination(videoReferences))
      : model3DSource === "text" ? Boolean(model3DPrompt.trim()) : Boolean(modelReferences[0]);

  useEffect(() => {
    return () => {
      mounted.current = false;
      window.clearTimeout(draftSaveTimer.current);
      if (latestDraft.current) saveDraft(latestDraft.current);
      templateCoverRequest.current += 1;
      if (templateCoverUrlRef.current) URL.revokeObjectURL(templateCoverUrlRef.current);
      historyRef.current.forEach((entry) => entry.urls.forEach((url) => URL.revokeObjectURL(url)));
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      await loadJobs();
      if (!stopped) timer = window.setTimeout(poll, 1_500);
    };
    void waitForRuntime()
      .then(() => { if (!stopped) void poll(); })
      .catch(() => undefined);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!draftReady.current) return;
    latestDraft.current = createDraft();
    window.clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = window.setTimeout(() => {
      if (latestDraft.current) saveDraft(latestDraft.current);
    }, 250);
    return () => window.clearTimeout(draftSaveTimer.current);
  }, [mode, templateIds, panelView, result?.run.id, selectedResult, imagePrompt, resolution, aspectRatio, outputs, videoPrompt, videoReferences, videoAspectRatio, videoResolution, videoDuration, model3D, model3DSource, model3DPrompt, model3DMultiView, model3DQuality, model3DTargetPolycount, model3DTexture, model3DTextureResolution, model3DPbr, model3DPose, model3DImageEnhancement]);

  useEffect(() => {
    const reload = () => void loadImageConfig();
    window.addEventListener(MODELS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(MODELS_CHANGED_EVENT, reload);
  }, []);

  useEffect(() => {
    if (!selectedImageModel) return;
    const option = selectedImageModel.generationOptions.find((candidate) =>
      candidate.resolution === resolution && candidate.aspectRatio === aspectRatio,
    ) ?? selectedImageModel.generationOptions.find((candidate) => candidate.aspectRatio === aspectRatio)
      ?? selectedImageModel.generationOptions[0];
    if (option) {
      setResolution(option.resolution);
      setAspectRatio(option.aspectRatio);
    }
    setOutputs(Math.min(outputs, selectedImageModel.maxOutputs) as ImageOutputCount);
    if (!selectedImageModel.supportsReferenceImage) {
      setImageReferences([]);
      setImageReferenceNames([]);
    }
  }, [selectedImageModel]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!resultActions.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  async function load(): Promise<void> {
    setPhase("loading");
    setLoadError(undefined);
    try {
      await waitForRuntime();
      if (!mounted.current) return;
      setPhase("ready");
      const draft = await getAssetStudioDraft();
      if (!mounted.current) return;
      if (draft) applyDraft(draft);
      draftReady.current = true;
      await Promise.all([loadImageConfig(), loadLibrary(), loadProjectList(), loadTemplates(), loadHistory()]);
    } catch (cause) {
      if (!mounted.current) return;
      setLoadError(errorMessage(cause));
      setPhase("error");
    }
  }

  async function loadTemplates(): Promise<void> {
    const [local, explore] = await Promise.allSettled([listAssetTemplates(), listExploreTemplates()]);
    if (!mounted.current) return;
    const localTemplates = local.status === "fulfilled" ? local.value : [];
    const exploreTemplates = explore.status === "fulfilled" ? explore.value : [];
    if (local.status === "fulfilled") setLocalTemplates(localTemplates);
    else setActionStatus({ type: "error", message: errorMessage(local.reason) });
    if (explore.status === "fulfilled") setExploreTemplates(exploreTemplates);
    const available = [...localTemplates, ...exploreTemplates];
    setTemplateIds((current) => ({
      ...(available.some((template) => template.id === current.image && template.mode === "image") ? { image: current.image } : {}),
      ...(available.some((template) => template.id === current.video && template.mode === "video") ? { video: current.video } : {}),
      ...(available.some((template) => template.id === current["3d"] && template.mode === "3d") ? { "3d": current["3d"] } : {}),
    }));
  }

  async function loadImageConfig(): Promise<void> {
    setImagePhase("loading");
    setImageLoadError(undefined);
    try {
      const [models, settings] = await Promise.all([listImageModels(), getImageGenerationSettings()]);
      if (!mounted.current) return;
      setImageModels(models);
      const selected = settings.model && models.some((model) => model.provider === settings.model?.provider && model.id === settings.model?.id)
        ? settings.model
        : models[0];
      setImageModelKey(selected ? modelKey(selected) : "");
      setImagePhase("ready");
    } catch (cause) {
      if (!mounted.current) return;
      setImageModels([]);
      setImageModelKey("");
      setImageLoadError(errorMessage(cause));
      setImagePhase("error");
    }
  }

  async function loadProjectList(): Promise<void> {
    setProjectsError(undefined);
    try {
      const loadedProjects = await listProjects();
      if (!mounted.current) return;
      setProjects(loadedProjects);
    } catch (cause) {
      if (!mounted.current) return;
      setProjects([]);
      setProjectsError(errorMessage(cause));
    }
  }

  async function loadLibrary(): Promise<void> {
    try {
      const assets = await listLibraryAssets();
      if (mounted.current) setLibraryAssets(assets);
    } catch (cause) {
      if (mounted.current) setActionStatus({ type: "error", message: errorMessage(cause) });
    }
  }

  async function loadHistory(): Promise<void> {
    try {
      const runs = await listToolRuns();
      const loaded = await Promise.allSettled(runs.map(async (run): Promise<PreviewResult> => ({
        run,
        urls: (await Promise.all(run.files.map((file) => getToolRunFile(run.id, file.name)))).map((blob) => URL.createObjectURL(blob)),
        title: historyRunTitle(run),
      })));
      const entries = loaded.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []);
      if (!mounted.current) {
        entries.forEach((entry) => entry.urls.forEach((url) => URL.revokeObjectURL(url)));
        return;
      }
      mergeHistoryResults(entries);
      const selection = pendingSelection.current;
      const selected = selection.runId ? entries.find((entry) => entry.run.id === selection.runId) : undefined;
      if (selected) {
        setResult(selected);
        setSelectedResult(Math.min(selection.output ?? 0, selected.urls.length - 1));
      }
    } catch (cause) {
      if (mounted.current) setActionStatus({ type: "error", message: errorMessage(cause) });
    }
  }

  async function loadJobs(): Promise<void> {
    try {
      const loaded = await listToolJobs();
      if (!mounted.current) return;
      setJobs(loaded);
      for (const job of loaded) {
        const run = job.status === "succeeded" ? job.run : undefined;
        if (!run || historyRef.current.some((entry) => entry.run.id === run.id) || hydratingJobs.current.has(job.id)) continue;
        hydratingJobs.current.add(job.id);
        void Promise.all(run.files.map((file) => getToolRunFile(run.id, file.name)))
          .then((blobs) => {
            if (!mounted.current) return;
            addHistoryResult({ run, urls: blobs.map((blob) => URL.createObjectURL(blob)), title: historyRunTitle(run) });
          })
          .catch((cause) => { if (mounted.current) setActionStatus({ type: "error", message: errorMessage(cause) }); })
          .finally(() => hydratingJobs.current.delete(job.id));
      }
    } catch (cause) {
      if (mounted.current) setActionStatus({ type: "error", message: errorMessage(cause) });
    }
  }

  async function generate(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    if (!canGenerate || submitting) return;
    setSubmitting(true);
    setGenerationError(undefined);
    setActionStatus(undefined);
    setMenuOpen(false);
    setHistoryDetailOpen(false);
    setPanelView("history");
    try {
      let job: ToolJob;
      if (mode === "image") {
        if (!selectedImageModel) throw new Error("Connect an image model before generating");
        job = await startToolJob("generate-image", {
          prompt: imagePrompt.trim(),
          imageModel: { provider: selectedImageModel.provider, id: selectedImageModel.id },
          resolution,
          aspectRatio,
          outputs,
          ...(imageReferences.length ? { images: imageReferences } : {}),
        }, selectedTemplate?.name);
      } else if (mode === "video") {
        job = await startToolJob("generate-video", {
          prompt: videoPrompt.trim(), duration: videoDuration, aspectRatio: videoAspectRatio, resolution: videoResolution,
          ...(videoReferences.length ? { references: videoReferences } : {}),
        }, selectedTemplate?.name);
      } else {
        const images = modelReferences
          .slice(0, !isMeshyT2 && model3DMultiView ? 4 : 1)
          .filter((image): image is PromptImage => image !== undefined);
        job = await startToolJob("image-to-3d", {
          ...(model3DSource === "text" ? { prompt: model3DPrompt.trim() } : { images }),
          model: model3D,
          ...(isMeshyT2 ? { targetPolycount: model3DTargetPolycount } : { quality: model3DQuality }),
          texture: model3DTexture,
          textureResolution: isMeshyT2 ? "2K" : model3DTextureResolution,
          pbr: model3DPbr,
          ...(!isMeshyT2 ? { pose: model3DPose } : {}),
          ...(model3DSource === "image" && !isMeshyT2 ? { imageEnhancement: model3DImageEnhancement } : {}),
        }, selectedTemplate?.name);
      }
      if (selectedTemplate?.author && auth.state.status === "signed-in") {
        void auth.requestAccessToken()
          .then((token) => token ? recordCommunityUse("template", selectedTemplate.id, token) : undefined)
          .then((stats) => {
            if (!stats || !mounted.current) return;
            setExploreTemplates((templates) => templates.map((template) => template.id === selectedTemplate.id ? { ...template, stats } : template));
          })
          .catch(() => undefined);
      }
      if (mounted.current) setJobs((current) => [job, ...current.filter((candidate) => candidate.id !== job.id)]);
    } catch (cause) {
      if (mounted.current) setGenerationError(errorMessage(cause));
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  async function cancelJob(jobId: string): Promise<void> {
    setJobActions((current) => new Set(current).add(jobId));
    try {
      const job = await cancelToolJob(jobId);
      if (mounted.current) setJobs((current) => current.map((candidate) => candidate.id === job.id ? job : candidate));
    } catch (cause) {
      if (mounted.current) setActionStatus({ type: "error", message: errorMessage(cause) });
    } finally {
      if (mounted.current) setJobActions((current) => withoutJob(current, jobId));
    }
  }

  async function retryJob(jobId: string): Promise<void> {
    setJobActions((current) => new Set(current).add(jobId));
    try {
      const job = await retryToolJob(jobId);
      if (mounted.current) setJobs((current) => [job, ...current.filter((candidate) => candidate.id !== jobId && candidate.id !== job.id)]);
    } catch (cause) {
      if (mounted.current) setActionStatus({ type: "error", message: errorMessage(cause) });
    } finally {
      if (mounted.current) setJobActions((current) => withoutJob(current, jobId));
    }
  }

  async function addToProject(project: ProjectState): Promise<void> {
    if (!result || !selectedFile || adding) return;
    setAdding(true);
    setActionStatus(undefined);
    setMenuOpen(false);
    try {
      await addToolResultToProject(project.id, { runId: result.run.id, fileName: selectedFile.name });
      if (mounted.current) setActionStatus({ type: "success", message: `Added to ${project.name}` });
    } catch (cause) {
      if (mounted.current) setActionStatus({ type: "error", message: errorMessage(cause) });
    } finally {
      if (mounted.current) setAdding(false);
    }
  }

  function applyTemplate(template: AssetTemplate): void {
    setMode(template.mode);
    setTemplateIds((current) => ({ ...current, [template.mode]: template.id }));
    const prompt = template.defaultPrompt ?? "";
    const defaults = template.defaults;
    if (template.mode === "image") {
      setImagePrompt(prompt);
      const option = selectedImageModel?.generationOptions.find((candidate) =>
        candidate.resolution === defaults?.imageResolution && candidate.aspectRatio === defaults.imageAspectRatio,
      ) ?? selectedImageModel?.generationOptions.find((candidate) => candidate.aspectRatio === defaults?.imageAspectRatio)
        ?? selectedImageModel?.generationOptions.find((candidate) => candidate.resolution === defaults?.imageResolution)
        ?? selectedImageModel?.generationOptions[0];
      if (option) {
        setResolution(option.resolution);
        setAspectRatio(option.aspectRatio);
      }
      const nextOutputs = defaults?.imageOutputs ?? outputs;
      setOutputs(selectedImageModel ? Math.min(nextOutputs, selectedImageModel.maxOutputs) as ImageOutputCount : nextOutputs);
    } else if (template.mode === "video") {
      setVideoPrompt(prompt);
      if (defaults?.videoResolution) setVideoResolution(defaults.videoResolution);
      if (defaults?.videoAspectRatio) setVideoAspectRatio(defaults.videoAspectRatio);
      if (defaults?.videoDuration) setVideoDuration(defaults.videoDuration);
    } else if (template.mode === "3d") {
      setModel3DPrompt(prompt);
      setModel3D(defaults?.model3DModel ?? "meshy-7");
      if (defaults?.model3DQuality) setModel3DQuality(defaults.model3DQuality);
      if (defaults?.model3DTargetPolycount) setModel3DTargetPolycount(defaults.model3DTargetPolycount);
      if (defaults?.model3DPose) setModel3DPose(defaults.model3DPose);
      if (defaults?.model3DSource) setModel3DSource(defaults.model3DSource);
    }
    setGenerationError(undefined);
    setReferenceError(undefined);
    setActionStatus(undefined);
    setMenuOpen(false);
  }

  function chooseMode(nextMode: StudioMode): void {
    if (nextMode === mode) return;
    setMode(nextMode);
    setGenerationError(undefined);
    setReferenceError(undefined);
    setActionStatus(undefined);
    setMenuOpen(false);
  }

  function choosePanelView(nextView: AssetPanelView): void {
    setPanelView(nextView);
    setHistoryDetailOpen(false);
    setMenuOpen(false);
  }

  function chooseImageModel(nextModelKey: string): void {
    const model = imageModels.find((candidate) => modelKey(candidate) === nextModelKey);
    if (!model) return;
    setImageModelKey(nextModelKey);
    void updateImageGenerationSettings({ model: { provider: model.provider, id: model.id } })
      .catch((cause) => { if (mounted.current) setActionStatus({ type: "error", message: errorMessage(cause) }); });
  }

  function openTemplateDialog(): void {
    setTemplateName("");
    setTemplateDescription("");
    setTemplateCover(undefined);
    replaceTemplateCoverUrl();
    setTemplateCoverBusy(false);
    setTemplateDialogError(undefined);
    setTemplateDialogOpen(true);
    setActionStatus(undefined);
  }

  function closeTemplateDialog(): void {
    templateCoverRequest.current += 1;
    setTemplateDialogOpen(false);
    setTemplateCover(undefined);
    replaceTemplateCoverUrl();
    setTemplateCoverBusy(false);
    setTemplateDialogError(undefined);
  }

  function replaceTemplateCoverUrl(next?: string): void {
    if (templateCoverUrlRef.current) URL.revokeObjectURL(templateCoverUrlRef.current);
    templateCoverUrlRef.current = next;
    setTemplateCoverUrl(next);
  }

  async function saveTemplate(): Promise<void> {
    const name = templateName.trim();
    if (!name || templateBusy || templateCoverBusy) return;
    setTemplateBusy(true);
    setTemplateDialogError(undefined);
    let created: LocalAssetTemplate | undefined;
    try {
      created = await createAssetTemplate(currentTemplateDefinition(name, templateDescription));
      const saved = templateCover ? await setAssetTemplateCover(created.id, templateCover) : created;
      setLocalTemplates((templates) => [...templates, saved]);
      closeTemplateDialog();
      applyTemplate(templateForGallery(saved));
      setActionStatus({ type: "success", message: "Template saved" });
    } catch (cause) {
      if (created && templateCover) await deleteAssetTemplate(created.id).catch(() => undefined);
      setTemplateDialogError(errorMessage(cause));
    } finally {
      setTemplateBusy(false);
    }
  }

  async function chooseTemplateCover(file: File | undefined): Promise<void> {
    if (!file || templateBusy) return;
    const request = ++templateCoverRequest.current;
    setTemplateCoverBusy(true);
    setTemplateDialogError(undefined);
    try {
      const cover = await imageToWebP(file);
      if (!mounted.current || request !== templateCoverRequest.current) return;
      setTemplateCover(cover);
      replaceTemplateCoverUrl(URL.createObjectURL(cover));
    } catch (cause) {
      if (mounted.current && request === templateCoverRequest.current) setTemplateDialogError(errorMessage(cause));
    } finally {
      if (mounted.current && request === templateCoverRequest.current) setTemplateCoverBusy(false);
    }
  }

  async function shareTemplate(template: AssetTemplate): Promise<void> {
    if (template.source !== "local" || templateBusy) return;
    const accessToken = await auth.requestAccessToken();
    if (!accessToken) return;
    setTemplateBusy(true);
    setActionStatus(undefined);
    try {
      const result = await publishAssetTemplate(template.id, accessToken);
      setLocalTemplates((templates) => templates.map((candidate) => candidate.id === template.id ? {
        ...candidate,
        publication: {
          templateId: result.template.id,
          releaseId: result.release.id,
          publishedAt: result.release.publishedAt,
          status: "listed",
        },
      } : candidate));
      setExploreTemplates(await listExploreTemplates());
      setActionStatus({ type: "success", message: template.publication ? "Template update published" : "Template published" });
    } catch (cause) {
      setActionStatus({ type: "error", message: errorMessage(cause) });
    } finally {
      setTemplateBusy(false);
    }
  }

  async function setTemplatePublication(template: AssetTemplate, status: "listed" | "unlisted"): Promise<void> {
    if (template.source !== "local" || !template.publication || templateBusy) return;
    const accessToken = await auth.requestAccessToken();
    if (!accessToken) return;
    setTemplateBusy(true);
    setActionStatus(undefined);
    try {
      const updated = await setAssetTemplatePublicationStatus(template.id, status, accessToken);
      setLocalTemplates((templates) => templates.map((candidate) => candidate.id === updated.id ? updated : candidate));
      setExploreTemplates(await listExploreTemplates());
      setActionStatus({ type: "success", message: status === "listed" ? "Template republished" : "Template removed from Explore" });
    } catch (cause) {
      setActionStatus({ type: "error", message: errorMessage(cause) });
    } finally {
      setTemplateBusy(false);
    }
  }

  async function deleteTemplate(template: AssetTemplate): Promise<void> {
    if (template.source !== "local" || templateBusy || !window.confirm(`Delete “${template.name}”?`)) return;
    setTemplateBusy(true);
    setActionStatus(undefined);
    try {
      if (template.publication?.status === "listed") {
        const accessToken = await auth.requestAccessToken();
        if (!accessToken) return;
        await setAssetTemplatePublicationStatus(template.id, "unlisted", accessToken);
      }
      await deleteAssetTemplate(template.id);
      setLocalTemplates((templates) => templates.filter((candidate) => candidate.id !== template.id));
      if (templateIds[template.mode] === template.id) setTemplateIds((current) => withoutTemplate(current, template.mode));
      setExploreTemplates(await listExploreTemplates());
      setActionStatus({ type: "success", message: "Template deleted" });
    } catch (cause) {
      setActionStatus({ type: "error", message: errorMessage(cause) });
    } finally {
      setTemplateBusy(false);
    }
  }

  function currentTemplateDefinition(name: string, description: string) {
    const prompt = mode === "image" ? imagePrompt : mode === "video" ? videoPrompt : model3DPrompt;
    const defaults = mode === "image"
      ? { imageResolution: resolution, imageAspectRatio: aspectRatio, imageOutputs: outputs }
      : mode === "video"
        ? { videoResolution, videoAspectRatio, videoDuration }
        : {
          model3DModel: model3D,
          ...(isMeshyT2 ? { model3DTargetPolycount } : { model3DQuality }),
          model3DPose,
          model3DSource,
        };
    return {
      mode,
      name,
      description: description.trim(),
      promptPlaceholder,
      ...(prompt.trim() ? { defaultPrompt: prompt.trim() } : {}),
      defaults,
    };
  }

  function addHistoryResult(entry: PreviewResult): void {
    mergeHistoryResults([entry]);
  }

  function createDraft(): AssetStudioDraft {
    return {
      mode,
      templateIds,
      panelView,
      ...(result ? { selectedRunId: result.run.id, selectedOutput: selectedResult } : {}),
      image: { prompt: imagePrompt, resolution, aspectRatio, outputs },
      video: { prompt: videoPrompt, references: videoReferences, resolution: videoResolution, aspectRatio: videoAspectRatio, duration: videoDuration },
      model3D: {
        prompt: model3DPrompt,
        model: model3D,
        source: model3DSource,
        multiView: model3DMultiView,
        quality: model3DQuality,
        targetPolycount: model3DTargetPolycount,
        texture: model3DTexture,
        textureResolution: model3DTextureResolution,
        pbr: model3DPbr,
        pose: model3DPose,
        imageEnhancement: model3DImageEnhancement,
      },
    };
  }

  function saveDraft(draft: AssetStudioDraft): void {
    void updateAssetStudioDraft(draft).catch(() => undefined);
  }

  function applyDraft(draft: AssetStudioDraft): void {
    setMode(draft.mode);
    setTemplateIds(draft.templateIds);
    setPanelView(draft.panelView);
    pendingSelection.current = { runId: draft.selectedRunId, output: draft.selectedOutput };
    setImagePrompt(draft.image.prompt);
    setResolution(draft.image.resolution);
    setAspectRatio(draft.image.aspectRatio);
    setOutputs(draft.image.outputs);
    setVideoPrompt(draft.video.prompt);
    setVideoReferences(draft.video.references);
    setVideoResolution(draft.video.resolution);
    setVideoAspectRatio(draft.video.aspectRatio);
    setVideoDuration(draft.video.duration);
    setModel3DPrompt(draft.model3D.prompt);
    const isDraftT2 = draft.model3D.model === "meshy-t2";
    setModel3D(draft.model3D.model);
    setModel3DSource(isDraftT2 ? "image" : draft.model3D.source);
    setModel3DMultiView(isDraftT2 ? false : draft.model3D.multiView);
    setModel3DQuality(draft.model3D.quality);
    setModel3DTargetPolycount(draft.model3D.targetPolycount);
    setModel3DTexture(draft.model3D.texture);
    setModel3DTextureResolution(isDraftT2 ? "2K" : draft.model3D.textureResolution ?? "2K");
    setModel3DPbr(draft.model3D.pbr ?? false);
    setModel3DPose(isDraftT2 ? "auto" : draft.model3D.pose);
    setModel3DImageEnhancement(draft.model3D.imageEnhancement);
  }

  function mergeHistoryResults(incoming: PreviewResult[]): void {
    const existingIds = new Set(historyRef.current.map((entry) => entry.run.id));
    const duplicates = incoming.filter((entry) => existingIds.has(entry.run.id));
    duplicates.forEach((entry) => entry.urls.forEach((url) => URL.revokeObjectURL(url)));
    const entries = [...historyRef.current, ...incoming.filter((entry) => !existingIds.has(entry.run.id))]
      .sort((left, right) => right.run.createdAt.localeCompare(left.run.createdAt));
    const evicted = entries.splice(HISTORY_LIMIT);
    evicted.forEach((result) => result.urls.forEach((url) => URL.revokeObjectURL(url)));
    historyRef.current = entries;
    setHistory(entries);
  }

  function chooseImageResolution(nextResolution: ImageResolution): void {
    if (!selectedImageModel) return;
    const option = selectedImageModel.generationOptions.find((candidate) => candidate.resolution === nextResolution && candidate.aspectRatio === aspectRatio)
      ?? selectedImageModel.generationOptions.find((candidate) => candidate.resolution === nextResolution);
    if (!option) return;
    setResolution(option.resolution);
    setAspectRatio(option.aspectRatio);
  }

  function chooseImageAspectRatio(nextAspectRatio: ImageAspectRatio): void {
    if (!selectedImageModel?.generationOptions.some((option) => option.resolution === resolution && option.aspectRatio === nextAspectRatio)) return;
    setAspectRatio(nextAspectRatio);
  }

  async function selectReference(files: File[]): Promise<void> {
    if (!files.length || uploadingReferences) return;
    setUploadingReferences(true);
    try {
      if (mode === "image" && imageReferences.length + files.length > 14) throw new Error("Select up to 14 reference images");
      if (mode === "video") {
        const prepared = await Promise.all(files.map(prepareVideoReferenceFile));
        validateVideoReferenceCounts([...videoReferences.map((reference) => reference.type), ...prepared.map((upload) => upload.type)]);
        validateVideoReferenceDurations(videoReferences.map((reference) => ({
          ...reference,
          duration: libraryAssets.find((asset) => asset.id === reference.assetId)?.duration,
        })), prepared);
        for (const upload of prepared) {
          const asset = await uploadLibraryAsset(upload.file, upload.mediaType, upload.duration);
          if (!mounted.current) return;
          setLibraryAssets((current) => [asset, ...current.filter((candidate) => candidate.id !== asset.id)]);
          setVideoReferences((current) => [...current, { type: upload.type, assetId: asset.id }]);
        }
        setReferenceError(undefined);
        return;
      }
      const selectedFiles = files;
      const nextImages = await Promise.all(selectedFiles.map((file) => readImage(file, mode !== "3d")));
      if (!mounted.current) return;
      if (mode === "image") {
        setImageReferences((current) => [...current, ...nextImages]);
        setImageReferenceNames((current) => [...current, ...selectedFiles.map((file) => file.name)]);
      }
      setReferenceError(undefined);
    } catch (cause) {
      if (mounted.current) setReferenceError(errorMessage(cause));
    } finally {
      if (mounted.current) setUploadingReferences(false);
    }
  }

  async function selectModelReference(index: number, files: File[]): Promise<void> {
    const file = files[0];
    if (!file) return;
    try {
      const image = await readImage(file, false);
      if (!mounted.current) return;
      setModelReferences((current) => replaceAt(current, index, image));
      setModelReferenceNames((current) => replaceAt(current, index, file.name));
      setReferenceError(undefined);
    } catch (cause) {
      if (mounted.current) setReferenceError(errorMessage(cause));
    }
  }

  function chooseModelReference(index: number): void {
    modelReferenceTarget.current = index;
    uploadInput.current?.click();
  }

  return (
    <main className="home-shell asset-studio-shell">
      <AppSidebar active="asset-studio" onNavigate={onNavigate} />
      <section className="asset-studio-content">
        <WindowDragRegion />
        <div className="asset-studio-workspace">
          <form className="asset-config-panel" onSubmit={generate}>
            {phase === "loading" ? <div className="asset-config-state"><LoaderCircle className="spin" size={16} />Loading studio</div> : null}
            {phase === "error" ? <div className="asset-config-state asset-config-error" role="alert"><span>{loadError}</span><button type="button" onClick={() => void load()}><RefreshCw size={13} />Retry</button></div> : null}
            {phase === "ready" ? (
              <div className="asset-config-fields">
                <ModeSwitcher mode={mode} onChange={chooseMode} />
                {mode === "image" ? (
                  <>
                    <Field label="Model" htmlFor="asset-model">
                      {imagePhase === "loading" ? <p className="asset-inline-state"><LoaderCircle className="spin" size={13} />Loading models</p> : null}
                      {imagePhase === "error" ? <div className="asset-inline-error" role="alert"><span>{imageLoadError}</span><button type="button" onClick={() => void loadImageConfig()}><RefreshCw size={12} />Retry</button></div> : null}
                      {imagePhase === "ready" && imageModels.length ? <ModelSelect id="asset-model" value={imageModelKey} options={imageModels.map((model) => ({ value: modelKey(model), label: model.name }))} onChange={chooseImageModel} /> : null}
                      {imagePhase === "ready" && !imageModels.length ? <p className="asset-inline-state">No image model is connected</p> : null}
                    </Field>
                    <PromptField id="asset-image-prompt" value={imagePrompt} placeholder={promptPlaceholder} onChange={setImagePrompt} />
                  </>
                ) : mode === "video" ? (
                  <>
                    <Field label="Model" htmlFor="asset-video-model"><ModelSelect id="asset-video-model" value={VIDEO_MODEL} options={VIDEO_MODEL_OPTIONS} onChange={() => undefined} /></Field>
                    <PromptField id="asset-video-prompt" value={videoPrompt} placeholder={promptPlaceholder} onChange={setVideoPrompt} />
                  </>
                ) : (
                  <>
                    <Field label="Model" htmlFor="asset-3d-model"><ModelSelect id="asset-3d-model" value={model3D} options={MODEL_3D_OPTIONS} onChange={(model) => {
                      setModel3D(model);
                      if (model === "meshy-t2") {
                        setModel3DSource("image");
                        setModel3DMultiView(false);
                        setModel3DPose("auto");
                        setModel3DTextureResolution("2K");
                      }
                    }} /></Field>
                    <Model3DInputField
                      source={model3DSource}
                      prompt={model3DPrompt}
                      images={modelReferences}
                      imageNames={modelReferenceNames}
                      multiView={model3DMultiView}
                      allowMultiView={!isMeshyT2}
                      promptPlaceholder={promptPlaceholder}
                      onSourceChange={setModel3DSource}
                      onPromptChange={setModel3DPrompt}
                      onMultiViewChange={setModel3DMultiView}
                      onChooseImage={chooseModelReference}
                      onSelectFiles={(index, files) => void selectModelReference(index, files)}
                      onRemoveImage={(index) => {
                        setModelReferences((current) => replaceAt(current, index, undefined));
                        setModelReferenceNames((current) => replaceAt(current, index, undefined));
                        setReferenceError(undefined);
                      }}
                    />
                  </>
                )}

                {mode === "image" ? <ImageReferenceField images={imageReferences} names={imageReferenceNames} disabled={uploadingReferences || !selectedImageModel?.supportsReferenceImage} onChoose={() => uploadInput.current?.click()} onRemove={(index) => {
                  setImageReferences((current) => current.filter((_, candidate) => candidate !== index));
                  setImageReferenceNames((current) => current.filter((_, candidate) => candidate !== index));
                  setReferenceError(undefined);
                }} /> : mode === "video" ? <VideoReferenceField references={videoReferences} assets={libraryAssets} disabled={uploadingReferences} onChoose={() => uploadInput.current?.click()} onRemove={(index) => {
                  setVideoReferences((current) => current.filter((_, candidate) => candidate !== index));
                  setReferenceError(undefined);
                }} /> : null}
                {(referenceError ?? (mode === "video" ? videoReferenceError : undefined)) && (mode !== "3d" || model3DSource === "image") ? <p className="asset-field-error" role="alert">{referenceError ?? videoReferenceError}</p> : null}
                <input ref={uploadInput} hidden multiple={mode !== "3d"} type="file" accept={mode === "3d" ? "image/png,image/jpeg" : mode === "video" ? VIDEO_REFERENCE_ACCEPT : "image/png,image/jpeg,image/webp"} onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = "";
                  if (mode === "3d") void selectModelReference(modelReferenceTarget.current, files);
                  else void selectReference(files);
                }} />

                {mode === "image" && selectedImageModel ? (
                  <>
                    <OptionGroup label="Resolution" values={supportedImageResolutions} value={resolution} onChange={chooseImageResolution} />
                    <OptionGroup label="Aspect ratio" values={supportedImageAspectRatios} value={aspectRatio} onChange={chooseImageAspectRatio} />
                    <OptionGroup label="Outputs" values={IMAGE_OUTPUT_COUNTS} value={outputs} isOptionDisabled={(value) => value > selectedImageModel.maxOutputs} onChange={setOutputs} />
                  </>
                ) : mode === "video" ? (
                  <>
                    <OptionGroup label="Resolution" values={VIDEO_RESOLUTIONS} value={videoResolution} format={(value) => value.toUpperCase()} onChange={setVideoResolution} />
                    <OptionGroup label="Aspect ratio" values={VIDEO_ASPECT_RATIOS} value={videoAspectRatio} format={(value) => value === "adaptive" ? "Auto" : value} onChange={setVideoAspectRatio} />
                    <RangeField label="Duration" value={videoDuration} min={4} max={15} onChange={setVideoDuration} />
                  </>
                ) : mode === "3d" ? (
                  <div className="asset-3d-options">
                    {isMeshyT2
                      ? <PolyCountField value={model3DTargetPolycount} onChange={setModel3DTargetPolycount} />
                      : <OptionGroup equal label="Quality" values={MODEL_3D_QUALITIES} value={model3DQuality} format={titleCase} onChange={setModel3DQuality} />}
                    <ToggleField label="Texture" checked={model3DTexture} onChange={setModel3DTexture} />
                    {!isMeshyT2 && model3DTexture ? <OptionGroup equal label="Texture resolution" values={MODEL_3D_TEXTURE_RESOLUTIONS} value={model3DTextureResolution} onChange={setModel3DTextureResolution} /> : null}
                    {model3DTexture ? <ToggleField label="PBR" checked={model3DPbr} onChange={setModel3DPbr} /> : null}
                    {!isMeshyT2 ? <OptionGroup equal label="Pose" values={MODEL_3D_POSES} value={model3DPose} format={(value) => value === "auto" ? "None" : value === "a-pose" ? "A-Pose" : "T-Pose"} onChange={setModel3DPose} /> : null}
                    {model3DSource === "image" && !isMeshyT2 ? <ToggleField label="Image enhancement" checked={model3DImageEnhancement} onChange={setModel3DImageEnhancement} /> : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="asset-config-actions">
              <button className="asset-save-template-button" type="button" aria-label="Save as template" title="Save as template" disabled={phase !== "ready" || templateBusy} onClick={openTemplateDialog}>
                {templateBusy ? <LoaderCircle className="spin" size={15} /> : <Bookmark size={16} />}
              </button>
              <button className="asset-generate-button" type="submit" disabled={phase !== "ready" || !canGenerate || submitting || uploadingReferences}>
                {submitting || uploadingReferences ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
                {uploadingReferences ? "Uploading..." : submitting ? "Submitting..." : "Generate"}
              </button>
            </div>
          </form>

          <section className="asset-result-panel" aria-label={panelView === "templates" ? "Asset templates" : "Generation history"}>
            <header><PanelViewSwitcher view={panelView} onChange={choosePanelView} /></header>
            <div className={`asset-result-canvas${panelView === "templates" ? " asset-template-gallery" : " asset-history-view"}${panelView === "history" && (history.length || jobs.length) ? " library-grid asset-history-grid" : ""}`}>
              {panelView === "templates" ? <TemplateGallery
                yours={yoursTemplates}
                explore={communityTemplates}
                selectedId={selectedTemplate?.id}
                busy={templateBusy}
                onSelect={applyTemplate}
                onPublish={(template) => void shareTemplate(template)}
                onSetPublication={(template, status) => void setTemplatePublication(template, status)}
                onDelete={(template) => void deleteTemplate(template)}
              /> : null}
              {panelView === "history" ? jobs.filter((job) => job.status !== "succeeded" || !job.run || !history.some((entry) => entry.run.id === job.run?.id)).map((job) => <GenerationJobCard key={job.id} job={job} busy={jobActions.has(job.id)} onCancel={() => void cancelJob(job.id)} onRetry={() => void retryJob(job.id)} />) : null}
              {panelView === "history" && generationError && !history.length && !jobs.length ? <div className="asset-result-empty asset-result-error" role="alert"><strong>Could not submit generation</strong><span>{generationError}</span></div> : null}
              {panelView === "history" && !generationError && !history.length && !jobs.length ? <div className="asset-result-empty"><span className="asset-result-empty-icon"><Sparkles size={24} /></span><strong>No history yet</strong><span>Generated assets will appear here.</span></div> : null}
              {panelView === "history" && history.length ? history.flatMap((entry) => entry.urls.map((url, index) => {
                return <HistoryAssetCard
                  key={`${entry.run.id}:${index}`}
                  entry={entry}
                  output={index}
                  url={url}
                  onOpen={() => { setResult(entry); setSelectedResult(index); setHistoryDetailOpen(true); setActionStatus(undefined); setMenuOpen(false); }}
                />;
              })) : null}
            </div>
            {panelView === "history" && historyDetailOpen && result && selectedFile && selectedUrl ? <AssetDialogShell
              title={result.title}
              subtitle={<><span>{studioModeLabel(studioModeForTool(result.run.toolId))}</span><span>{formatHistoryTime(result.run.createdAt)}</span></>}
              labelledBy="asset-history-detail-title"
              onClose={() => { setHistoryDetailOpen(false); setMenuOpen(false); }}
              onEscape={() => { if (menuOpen) setMenuOpen(false); else setHistoryDetailOpen(false); }}
              preview={<AssetMedia type={assetMediaTypeForMode(studioModeForTool(result.run.toolId))} url={selectedUrl} label={result.title} />}
              headerActionsRef={resultActions}
              headerActions={<>
                <button type="button" aria-label="Result actions" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={17} /></button>
                {menuOpen ? <div className="asset-result-menu" role="menu">
                  <a href={selectedUrl} download={selectedFile.name} role="menuitem"><Download size={14} />Download</a>
                  {projects.length ? <div className="asset-result-projects">
                    <button type="button" role="menuitem" aria-haspopup="menu" disabled={adding}><FolderInput size={14} /><span>Add to Project</span><ChevronRight className="asset-result-menu-chevron" size={13} /></button>
                    <div className="asset-result-submenu" role="menu">
                      {projects.map((project) => <button type="button" role="menuitem" key={project.id} disabled={adding} title={project.name} onClick={() => void addToProject(project)}><span>{project.name}</span></button>)}
                    </div>
                  </div> : null}
                  {projectsError ? <button type="button" role="menuitem" onClick={() => void loadProjectList()}><RefreshCw size={14} />Retry projects</button> : null}
                  <button type="button" role="menuitem" onClick={() => void generate()}><RefreshCw size={14} />Regenerate</button>
                </div> : null}
              </>}
              footer={<footer className="library-dialog-footer library-dialog-footer-compact">
                <dl>
                  <div><dt>Type</dt><dd>{studioModeLabel(studioModeForTool(result.run.toolId))}</dd></div>
                  <div><dt>Created</dt><dd>{formatHistoryTime(result.run.createdAt)}</dd></div>
                  <div className="library-dialog-path"><dt>File</dt><dd>{selectedFile.name}</dd></div>
                </dl>
                <div className="library-dialog-footer-actions">
                  {actionStatus ? <span className={actionStatus.type === "error" ? "is-error" : undefined} role={actionStatus.type === "error" ? "alert" : "status"}>{actionStatus.message}</span> : null}
                </div>
              </footer>}
            /> : null}
            {templateDialogOpen ? <div className="asset-template-dialog" role="dialog" aria-modal="true" aria-label="Save template">
              <form onSubmit={(event) => { event.preventDefault(); void saveTemplate(); }}>
                <strong>Save template</strong>
                <label className="asset-template-cover-field">
                  <span>Cover <small>Optional</small></span>
                  <span className="asset-template-cover-preview">
                    {templateCoverBusy ? <span><LoaderCircle className="spin" size={20} />Processing...</span> : templateCoverUrl ? <img src={templateCoverUrl} alt="Template cover preview" /> : <span><Image size={20} />Choose an image</span>}
                  </span>
                  <input hidden type="file" accept="image/png,image/jpeg,image/webp" disabled={templateBusy || templateCoverBusy} onChange={(event) => void chooseTemplateCover(event.target.files?.[0])} />
                </label>
                <label htmlFor="asset-template-name">Name</label>
                <input id="asset-template-name" autoFocus value={templateName} maxLength={80} disabled={templateBusy} onChange={(event) => setTemplateName(event.target.value)} />
                <label htmlFor="asset-template-description">Description</label>
                <textarea id="asset-template-description" value={templateDescription} maxLength={240} disabled={templateBusy} onChange={(event) => setTemplateDescription(event.target.value)} />
                {templateDialogError ? <p className="asset-template-dialog-error" role="alert">{templateDialogError}</p> : null}
                <div><button type="button" disabled={templateBusy} onClick={closeTemplateDialog}>Cancel</button><button type="submit" disabled={!templateName.trim() || templateBusy || templateCoverBusy}>{templateBusy ? "Saving..." : "Save"}</button></div>
              </form>
            </div> : null}
            {generationError && history.length ? <p className="asset-result-notice is-error" role="alert">Generation failed: {generationError}</p> : actionStatus ? <p className={`asset-result-notice${actionStatus.type === "error" ? " is-error" : ""}`} role={actionStatus.type === "error" ? "alert" : "status"}>{actionStatus.message}</p> : null}
          </section>
        </div>
      </section>
    </main>
  );
}

function PanelViewSwitcher({ view, disabled = false, onChange }: { view: AssetPanelView; disabled?: boolean; onChange: (view: AssetPanelView) => void }) {
  return <div className="asset-panel-switcher" aria-label="Asset Studio view">{(["templates", "history"] as const).map((value) => <button key={value} type="button" className={view === value ? "is-active" : undefined} aria-pressed={view === value} disabled={disabled} onClick={() => onChange(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>;
}

function ModeSwitcher({ mode, disabled = false, onChange }: { mode: StudioMode; disabled?: boolean; onChange: (mode: StudioMode) => void }) {
  const options = [
    { value: "image", label: "Image", icon: Image },
    { value: "video", label: "Video", icon: Film },
    { value: "3d", label: "3D", icon: Box },
  ] as const;
  return <div className="asset-mode-switcher" aria-label="Asset type">{options.map(({ value, label, icon: Icon }) => <button key={value} type="button" className={mode === value ? "is-active" : undefined} aria-pressed={mode === value} disabled={disabled} onClick={() => onChange(value)}><Icon size={13} />{label}</button>)}</div>;
}

function TemplateGallery({ yours, explore, selectedId, busy, onSelect, onPublish, onSetPublication, onDelete }: {
  yours: readonly AssetTemplate[];
  explore: readonly AssetTemplate[];
  selectedId?: string;
  busy: boolean;
  onSelect: (template: AssetTemplate) => void;
  onPublish: (template: AssetTemplate) => void;
  onSetPublication: (template: AssetTemplate, status: "listed" | "unlisted") => void;
  onDelete: (template: AssetTemplate) => void;
}) {
  return <div className="asset-template-sections">
    <TemplateSection title="Yours" templates={yours} selectedId={selectedId} busy={busy} empty="No saved templates" onSelect={onSelect} onPublish={onPublish} onSetPublication={onSetPublication} onDelete={onDelete} />
    <TemplateSection title="Explore" templates={explore} selectedId={selectedId} busy={busy} empty="No templates available" onSelect={onSelect} />
  </div>;
}

function TemplateSection({ title, templates, selectedId, busy, empty, onSelect, onPublish, onSetPublication, onDelete }: {
  title: string;
  templates: readonly AssetTemplate[];
  selectedId?: string;
  busy: boolean;
  empty?: string;
  onSelect: (template: AssetTemplate) => void;
  onPublish?: (template: AssetTemplate) => void;
  onSetPublication?: (template: AssetTemplate, status: "listed" | "unlisted") => void;
  onDelete?: (template: AssetTemplate) => void;
}) {
  return <section className="asset-template-section">
    <h2>{title}</h2>
    {templates.length ? <div className="asset-template-list">{templates.map((template) => <TemplateCard
      key={`${template.source}:${template.id}`}
      template={template}
      selected={template.id === selectedId}
      busy={busy}
      onSelect={onSelect}
      onPublish={onPublish}
      onSetPublication={onSetPublication}
      onDelete={onDelete}
    />)}</div> : empty ? <p>{empty}</p> : null}
  </section>;
}

function TemplateCard({ template, selected, busy, onSelect, onPublish, onSetPublication, onDelete }: {
  template: AssetTemplate;
  selected: boolean;
  busy: boolean;
  onSelect: (template: AssetTemplate) => void;
  onPublish?: (template: AssetTemplate) => void;
  onSetPublication?: (template: AssetTemplate, status: "listed" | "unlisted") => void;
  onDelete?: (template: AssetTemplate) => void;
}) {
  const publication = template.source === "local" ? template.publication : undefined;
  const [actionsOpen, setActionsOpen] = useState(false);
  const actions = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!actionsOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!actions.current?.contains(event.target as Node)) setActionsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActionsOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [actionsOpen]);
  return <article className={`asset-template-card${selected ? " is-selected" : ""}${actionsOpen ? " is-menu-open" : ""}`}>
    <button className="asset-template-card-open" type="button" aria-label={`${template.name}: ${template.description}`} aria-pressed={selected} disabled={busy} onClick={() => onSelect(template)}>
      <TemplatePreview template={template} />
      <span className="asset-template-card-copy"><strong>{template.name}</strong>{publication?.status === "listed" ? <small>Published</small> : publication ? <small>Unlisted</small> : null}</span>
    </button>
    {template.source === "local" ? <div className="asset-template-actions" ref={actions}>
      <button className="asset-template-actions-trigger" type="button" aria-label={`Manage ${template.name}`} title="Template actions" aria-haspopup="menu" aria-expanded={actionsOpen} disabled={busy} onClick={() => setActionsOpen((open) => !open)}><MoreHorizontal size={15} /></button>
      {actionsOpen ? <div role="menu">
        {publication?.status === "listed"
          ? <button type="button" role="menuitem" disabled={busy} onClick={() => { setActionsOpen(false); onSetPublication?.(template, "unlisted"); }}>Unpublish</button>
          : <button type="button" role="menuitem" disabled={busy} onClick={() => { setActionsOpen(false); publication ? onSetPublication?.(template, "listed") : onPublish?.(template); }}>{publication ? "Republish" : "Publish"}</button>}
        <button className="is-danger" type="button" role="menuitem" disabled={busy} onClick={() => { setActionsOpen(false); onDelete?.(template); }}><Trash2 size={13} />Delete</button>
      </div> : null}
    </div> : null}
    {template.author && template.stats ? <CommunityMeta type="template" id={template.id} author={template.author} stats={template.stats} useLabel="uses" /> : null}
  </article>;
}

function TemplatePreview({ template }: { template: AssetTemplate }) {
  const [coverUrl, setCoverUrl] = useState<string>();
  useEffect(() => {
    if (!template.hasCover) return;
    let active = true;
    const loadCover = template.source === "local"
      ? getAssetTemplateCover(template.id)
      : template.source === "catalog" && template.releaseId
        ? getExploreTemplateCover(template.id, template.releaseId)
        : Promise.resolve(undefined);
    void loadCover.then((cover) => {
      if (!active || !cover) return;
      setCoverUrl(URL.createObjectURL(cover));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [template.hasCover, template.id, template.releaseId, template.source]);
  useEffect(() => () => { if (coverUrl) URL.revokeObjectURL(coverUrl); }, [coverUrl]);
  return <span className="asset-template-preview">
    {coverUrl ? <img src={coverUrl} alt="" /> : <span><HistoryIcon mode={template.mode} /></span>}
    <span className="asset-template-type"><HistoryIcon mode={template.mode} size={11} />{template.mode === "3d" ? "3D" : template.mode[0].toUpperCase() + template.mode.slice(1)}</span>
  </span>;
}

function templateForGallery(template: LocalAssetTemplate | ExploreAssetTemplate): AssetTemplate {
  return { ...template };
}

function HistoryIcon({ mode, size = 24 }: { mode: StudioMode; size?: number }) {
  if (mode === "video") return <Film size={size} />;
  if (mode === "3d") return <Box size={size} />;
  return <Image size={size} />;
}

function GenerationJobCard({ job, busy, onCancel, onRetry }: {
  job: ToolJob;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const mode = studioModeForTool(job.toolId);
  const active = job.status === "running" || job.status === "succeeded";
  const status = job.status === "running" ? "Generating"
      : job.status === "succeeded" ? "Finishing"
        : job.status === "cancelled" ? "Cancelled" : "Failed";
  const detail = job.error ? `${status} · ${job.error}` : `${status} · ${formatHistoryTime(job.createdAt)}`;
  return <article className={`library-asset-card asset-history-card asset-job-card is-${job.status}`} aria-label={`${job.title}: ${status}`}>
    <div className="asset-job-preview">
      <span className="asset-job-icon">{active ? <LoaderCircle className="spin" size={25} /> : <HistoryIcon mode={mode} size={24} />}</span>
      <span className="library-asset-type"><HistoryIcon mode={mode} size={11} />{studioModeLabel(mode)}</span>
      {job.status === "running"
        ? <button className="asset-job-action" type="button" aria-label={`Cancel ${job.title}`} title="Cancel generation" disabled={busy} onClick={onCancel}>{busy ? <LoaderCircle className="spin" size={14} /> : <X size={14} />}</button>
        : job.status === "failed" || job.status === "cancelled"
          ? <button className="asset-job-action" type="button" aria-label={`Retry ${job.title}`} title="Retry generation" disabled={busy} onClick={onRetry}>{busy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}</button>
          : null}
    </div>
    <div className="library-asset-info">
      <strong title={job.title}>{job.title}</strong>
      <span className="asset-job-status" title={detail}>{detail}</span>
    </div>
  </article>;
}

function HistoryAssetCard({ entry, output, url, onOpen }: {
  entry: PreviewResult;
  output: number;
  url: string;
  onOpen: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [card, visible] = useNearViewport<HTMLElement>();
  const actions = useRef<HTMLDivElement>(null);
  const mode = studioModeForTool(entry.run.toolId);
  const file = entry.run.files[output];
  const badge = mode === "video" ? <><Play size={11} />Video</> : mode === "3d" ? <><Box size={11} />3D</> : undefined;

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!actions.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  return <AssetCardShell
    title={entry.title}
    subtitle={<>{studioModeLabel(mode)} · {formatHistoryTime(entry.run.createdAt)}</>}
    preview={visible ? <ResultMedia mode={mode} url={url} label={entry.title} preview /> : <HistoryIcon mode={mode} />}
    badge={badge}
    actions={<div className="library-asset-actions" ref={actions}>
      <button className="library-asset-menu" type="button" aria-label={`Actions for ${entry.title}`} aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={16} /></button>
      {menuOpen ? <div className="library-asset-actions-menu asset-history-actions-menu" role="menu">
        <a href={url} download={file?.name} role="menuitem" onClick={() => setMenuOpen(false)}><Download size={13} />Download</a>
      </div> : null}
    </div>}
    className="asset-history-card"
    articleRef={card}
    onOpen={onOpen}
  />;
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return <div className="asset-field"><label htmlFor={htmlFor}>{label}</label>{children}</div>;
}

function ModelSelect<T extends string>({ id, value, options, disabled = false, onChange }: { id: string; value: T; options: readonly { value: T; label: string }[]; disabled?: boolean; onChange: (value: T) => void }) {
  return <div className="asset-select-wrap"><select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown size={14} /></div>;
}

function PromptField({ id, value, placeholder, maxLength = 2000, disabled = false, onChange }: { id: string; value: string; placeholder: string; maxLength?: number; disabled?: boolean; onChange: (value: string) => void }) {
  return <Field label="Prompt" htmlFor={id}><PromptControl id={id} value={value} placeholder={placeholder} maxLength={maxLength} disabled={disabled} onChange={onChange} /></Field>;
}

function PromptControl({ id, value, placeholder, maxLength, ariaLabel, disabled, onChange }: { id: string; value: string; placeholder: string; maxLength: number; ariaLabel?: string; disabled: boolean; onChange: (value: string) => void }) {
  return <div className="asset-prompt-wrap"><textarea id={id} aria-label={ariaLabel} maxLength={maxLength} value={value} placeholder={placeholder} disabled={disabled} onChange={(event) => onChange(event.target.value)} /><span>{value.length.toLocaleString()} / {maxLength.toLocaleString()}</span></div>;
}

function Model3DInputField({ source, prompt, images, imageNames, multiView, allowMultiView, promptPlaceholder, disabled = false, onSourceChange, onPromptChange, onMultiViewChange, onChooseImage, onSelectFiles, onRemoveImage }: { source: Model3DSource; prompt: string; images: (PromptImage | undefined)[]; imageNames: (string | undefined)[]; multiView: boolean; allowMultiView: boolean; promptPlaceholder: string; disabled?: boolean; onSourceChange: (source: Model3DSource) => void; onPromptChange: (prompt: string) => void; onMultiViewChange: (value: boolean) => void; onChooseImage: (index: number) => void; onSelectFiles: (index: number, files: File[]) => void; onRemoveImage: (index: number) => void }) {
  return <div className={`asset-3d-input is-${source}`}><div className="asset-3d-input-header"><span>Input</span>{allowMultiView ? <SourceSwitch value={source} disabled={disabled} onChange={onSourceChange} /> : null}</div><div className="asset-3d-input-body">{source === "text"
    ? <PromptControl id="asset-3d-prompt" ariaLabel="Prompt" value={prompt} maxLength={800} disabled={disabled} placeholder={promptPlaceholder} onChange={onPromptChange} />
    : <Model3DReferenceField images={images} names={imageNames} multiView={multiView} allowMultiView={allowMultiView} disabled={disabled} onMultiViewChange={onMultiViewChange} onChoose={onChooseImage} onFiles={onSelectFiles} onRemove={onRemoveImage} />}</div></div>;
}

function SourceSwitch({ value, disabled, onChange }: { value: Model3DSource; disabled: boolean; onChange: (value: Model3DSource) => void }) {
  return <fieldset className="asset-source-switch" disabled={disabled}><legend className="visually-hidden">3D input type</legend>{MODEL_3D_SOURCE_OPTIONS.map((option) => <label key={option.value}><input type="radio" name="asset-3d-source" value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} /><span>{option.label}</span></label>)}</fieldset>;
}

function ImageReferenceField({ images, names, max = 14, primaryLabel, disabled, onChoose, onRemove }: { images: PromptImage[]; names: string[]; max?: number; primaryLabel?: string; disabled: boolean; onChoose: () => void; onRemove: (index: number) => void }) {
  return <Field label="Reference images"><div className="asset-reference-list">{images.map((image, index) => {
    const name = names[index] ?? `Reference ${index + 1}`;
    const label = index === 0 && primaryLabel ? `${name} · ${primaryLabel}` : name;
    return <div className="asset-reference-item" key={`${name}-${index}`}><img src={`data:${image.mediaType};base64,${image.data}`} alt="" /><span title={label}>{label}</span><button type="button" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => onRemove(index)}><X size={13} /></button></div>;
  })}{images.length < max ? <button className="asset-reference-add" type="button" disabled={disabled} onClick={onChoose}><Plus size={16} /><span>{images.length ? "Add more" : "Add reference images"}</span><small>{images.length}/{max}</small></button> : null}</div></Field>;
}

function VideoReferenceField({ references, assets, disabled, onChoose, onRemove }: { references: VideoGenerationReference[]; assets: LibraryAsset[]; disabled: boolean; onChoose: () => void; onRemove: (index: number) => void }) {
  return <Field label="References"><div className="asset-reference-list">{references.map((reference, index) => {
    const number = references.slice(0, index + 1).filter((candidate) => candidate.type === reference.type).length;
    return <VideoReferenceItem key={`${reference.type}:${reference.assetId}:${index}`} reference={reference} asset={assets.find((candidate) => candidate.id === reference.assetId)} label={`${titleCase(reference.type)} ${number}`} disabled={disabled} onRemove={() => onRemove(index)} />;
  })}<button className="asset-reference-add" type="button" disabled={disabled} onClick={onChoose}><Plus size={16} /><span>{references.length ? "Add more" : "Add references"}</span><small>Images, video, or audio</small></button></div></Field>;
}

function VideoReferenceItem({ reference, asset, label, disabled, onRemove }: { reference: VideoGenerationReference; asset?: LibraryAsset; label: string; disabled: boolean; onRemove: () => void }) {
  const preview = useWorkspaceAssetUrl(undefined, "", 0, reference.type === "audio" ? undefined : asset?.id);
  const Icon = reference.type === "image" ? Image : reference.type === "video" ? Film : Music2;
  return <div className="asset-reference-item">
    {preview.url && reference.type === "image" ? <img src={preview.url} alt="" /> : null}
    {preview.url && reference.type === "video" ? <video src={preview.url} muted playsInline preload="metadata" /> : null}
    {reference.type === "audio" || !preview.url ? <span className="asset-reference-media" aria-hidden="true"><Icon size={16} /></span> : null}
    <span className="asset-reference-copy"><strong>{label}</strong><small title={asset?.name}>{asset?.name ?? "Missing asset"}</small></span>
    <button type="button" aria-label={`Remove ${label}`} disabled={disabled} onClick={onRemove}><X size={13} /></button>
  </div>;
}

const MODEL_3D_REFERENCE_LABELS = ["Main view", "Left", "Back", "Right"] as const;

function Model3DReferenceField({ images, names, multiView, allowMultiView, disabled, onMultiViewChange, onChoose, onFiles, onRemove }: { images: (PromptImage | undefined)[]; names: (string | undefined)[]; multiView: boolean; allowMultiView: boolean; disabled: boolean; onMultiViewChange: (value: boolean) => void; onChoose: (index: number) => void; onFiles: (index: number, files: File[]) => void; onRemove: (index: number) => void }) {
  return <div className="asset-3d-references">
    <Model3DReferenceSlot index={0} label={MODEL_3D_REFERENCE_LABELS[0]} image={images[0]} name={names[0]} disabled={disabled} primary onChoose={onChoose} onFiles={onFiles} onRemove={onRemove} />
    {allowMultiView ? <><div className={`asset-3d-view-grid${multiView ? " is-enabled" : ""}`} aria-label="Additional views">
      {MODEL_3D_REFERENCE_LABELS.slice(1).map((label, offset) => {
        const index = offset + 1;
        return <Model3DReferenceSlot key={label} index={index} label={label} image={images[index]} name={names[index]} disabled={disabled || !multiView} onChoose={onChoose} onFiles={onFiles} onRemove={onRemove} />;
      })}
    </div>
    <ToggleField label="Multi-view" checked={multiView} disabled={disabled} onChange={onMultiViewChange} /></> : null}
  </div>;
}

function Model3DReferenceSlot({ index, label, image, name, primary = false, disabled, onChoose, onFiles, onRemove }: { index: number; label: string; image?: PromptImage; name?: string; primary?: boolean; disabled: boolean; onChoose: (index: number) => void; onFiles: (index: number, files: File[]) => void; onRemove: (index: number) => void }) {
  function acceptDrop(event: ReactDragEvent<HTMLDivElement>): void {
    event.preventDefault();
    if (!disabled) onFiles(index, [...event.dataTransfer.files]);
  }

  function acceptPaste(event: ReactClipboardEvent<HTMLDivElement>): void {
    const files = [...event.clipboardData.files];
    if (!disabled && files.length) {
      event.preventDefault();
      onFiles(index, files);
    }
  }

  return <div className={`asset-3d-reference-slot${primary ? " is-primary" : ""}${image ? " has-image" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={acceptDrop} onPaste={acceptPaste}>
    <button type="button" disabled={disabled} aria-label={`${image ? "Replace" : "Add"} ${label.toLowerCase()}`} title={name} onClick={() => onChoose(index)}>
      {image ? <img src={`data:${image.mediaType};base64,${image.data}`} alt="" /> : <Upload size={primary ? 27 : 20} />}
      <strong>{label}</strong>
      {primary ? <small>PNG or JPG</small> : null}
    </button>
    {image ? <button className="asset-3d-reference-remove" type="button" aria-label={`Remove ${label.toLowerCase()}`} disabled={disabled} onClick={() => onRemove(index)}><X size={12} /></button> : null}
  </div>;
}

function ResultMedia({ mode, url, label, preview = false }: { mode: StudioMode; url: string; label: string; preview?: boolean }) {
  if (mode === "3d") return <ModelPreview source={url} label="Generated 3D model" minHeight={420} interactive={!preview} />;
  if (mode === "video") return <video src={url} controls={!preview} muted={preview} playsInline preload="metadata" />;
  return <img src={url} alt={label} />;
}

function OptionGroup<T extends string | number>({ label, values, value, disabled = false, equal = false, isOptionDisabled, format, onChange }: { label: string; values: readonly T[]; value: T; disabled?: boolean; equal?: boolean; isOptionDisabled?: (value: T) => boolean; format?: (value: T) => string; onChange: (value: T) => void }) {
  return <fieldset className={`asset-option-group${equal ? " is-equal" : ""}`} disabled={disabled}><legend>{label}</legend><div style={equal ? { gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))` } : undefined}>{values.map((option) => <button type="button" key={option} className={option === value ? "is-active" : undefined} aria-pressed={option === value} disabled={disabled || isOptionDisabled?.(option)} onClick={() => onChange(option)}>{format ? format(option) : option}</button>)}</div></fieldset>;
}

function RangeField({ label, value, min, max, disabled = false, onChange }: { label: string; value: number; min: number; max: number; disabled?: boolean; onChange: (value: number) => void }) {
  const style = { "--asset-range-progress": `${((value - min) / (max - min)) * 100}%` } as CSSProperties;
  return <div className="asset-range-field"><div><label htmlFor="asset-video-duration">{label}</label><output htmlFor="asset-video-duration">{value}s</output></div><input id="asset-video-duration" type="range" value={value} min={min} max={max} step={1} disabled={disabled} style={style} onChange={(event) => onChange(Number(event.target.value))} /><div className="asset-range-bounds"><span>{min}s</span><span>{max}s</span></div></div>;
}

function PolyCountField({ value, disabled = false, onChange }: { value: number; disabled?: boolean; onChange: (value: number) => void }) {
  const min = 100;
  const max = 15_000;
  const style = { "--asset-range-progress": `${((value - min) / (max - min)) * 100}%` } as CSSProperties;
  const update = (next: number) => {
    if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, Math.round(next))));
  };
  return <div className="asset-number-range-field"><div><label htmlFor="asset-3d-polycount">Poly Count</label><input aria-label="Poly count value" type="number" value={value} min={min} max={max} step={100} disabled={disabled} onChange={(event) => update(event.target.valueAsNumber)} /></div><input id="asset-3d-polycount" type="range" value={value} min={min} max={max} step={100} disabled={disabled} style={style} onChange={(event) => update(event.target.valueAsNumber)} /><div className="asset-range-bounds"><span>{min.toLocaleString()}</span><span>{max.toLocaleString()}</span></div></div>;
}

function ToggleField({ label, checked, disabled = false, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <div className="asset-toggle-field"><span>{label}</span><button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button></div>;
}

function titleCase(value: string): string {
  return value[0]?.toUpperCase() + value.slice(1);
}

function studioModeLabel(mode: StudioMode): string {
  return mode === "3d" ? "3D" : titleCase(mode);
}

function assetMediaTypeForMode(mode: StudioMode): "image" | "video" | "model" {
  return mode === "3d" ? "model" : mode;
}

function studioModeForTool(toolId: ToolRun["toolId"]): StudioMode {
  if (toolId === "generate-video") return "video";
  if (toolId === "image-to-3d") return "3d";
  return "image";
}

function defaultRunTitle(toolId: ToolRun["toolId"]): string {
  if (toolId === "generate-video") return "Generated Video";
  if (toolId === "image-to-3d") return "Generated 3D Model";
  return "Generated Image";
}

function historyRunTitle(run: ToolRun): string {
  return run.title ?? defaultRunTitle(run.toolId);
}

function formatHistoryTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

async function readImage(file: File, allowWebP: boolean): Promise<PromptImage> {
  const supported = file.type === "image/png" || file.type === "image/jpeg" || (allowWebP && file.type === "image/webp");
  if (!supported) throw new Error(`Use a PNG, JPEG${allowWebP ? ", or WebP" : ""} image`);
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
  return { mediaType: file.type as PromptImage["mediaType"], data };
}

function replaceAt<T>(values: readonly (T | undefined)[], index: number, value: T | undefined): (T | undefined)[] {
  const next = [...values];
  next[index] = value;
  while (next.length && next.at(-1) === undefined) next.pop();
  return next;
}

function withoutJob(jobIds: ReadonlySet<string>, jobId: string): Set<string> {
  const next = new Set(jobIds);
  next.delete(jobId);
  return next;
}

function withoutTemplate(templateIds: Partial<Record<StudioMode, string>>, mode: StudioMode): Partial<Record<StudioMode, string>> {
  const next = { ...templateIds };
  delete next[mode];
  return next;
}

function modelKey(model: Pick<ImageModel, "provider" | "id">): string {
  return JSON.stringify([model.provider, model.id]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
