import { Bookmark, Box, ChevronDown, ChevronRight, Download, Film, FolderInput, Image, LoaderCircle, MoreHorizontal, Plus, RefreshCw, Sparkles, Trash2, Upload, X } from "./icons.js";
import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type DragEvent as ReactDragEvent, type FormEvent, type ReactNode } from "react";
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_OUTPUT_COUNTS,
  IMAGE_RESOLUTIONS,
  MODEL_3D_POSES,
  MODEL_3D_QUALITIES,
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
  type ProjectState,
  type PromptImage,
  type ToolRun,
  type VideoAspectRatio,
  type VideoResolution,
} from "../shared/contracts.js";
import { addToolResultToProject, createAssetTemplate, deleteAssetTemplate, getAssetStudioDraft, getAssetTemplateCover, getExploreTemplateCover, getImageGenerationSettings, getToolRunFile, listAssetTemplates, listExploreTemplates, listImageModels, listProjects, listToolRuns, MODELS_CHANGED_EVENT, publishAssetTemplate, recordCommunityUse, runTool, setAssetTemplateCover, setAssetTemplatePublicationStatus, updateAssetStudioDraft, updateImageGenerationSettings, waitForRuntime } from "./api.js";
import { ASSET_TEMPLATES, defaultTemplateForMode, type AssetTemplate, type Model3DSource, type StudioMode } from "./asset-templates.js";
import type { ExploreAssetTemplate, LocalAssetTemplate } from "../shared/asset-templates.js";
import { OPEN_GAME_TEMPLATE_AUTHOR } from "../shared/built-in-asset-templates.js";
import type { AssetStudioDraft } from "../shared/asset-studio-draft.js";
import { AppSidebar } from "./app-sidebar.js";
import { useAuth } from "./auth.js";
import type { AppNavigationTarget, SidebarPage } from "./routes.js";
import { ModelPreview } from "./model-preview.js";
import { WindowDragRegion } from "./window-drag-region.js";
import { CommunityMeta } from "./community-meta.js";
import { imageToWebP } from "./image.js";

interface AssetStudioPageProps {
  onNavigate: (page: AppNavigationTarget) => void;
}

const VIDEO_MODEL_OPTIONS = [{ value: VIDEO_MODEL, label: "Seedance 2.0" }] as const;
const VIDEO_REFERENCE_LIMIT = 9;
const MODEL_3D_OPTIONS = [
  { value: "meshy-t2", label: "Meshy T2 - Game-ready" },
  { value: "meshy-7", label: "Meshy 7 - High detail" },
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
  const [videoReferences, setVideoReferences] = useState<PromptImage[]>([]);
  const [videoReferenceNames, setVideoReferenceNames] = useState<string[]>([]);
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
  const [model3DPose, setModel3DPose] = useState<Model3DPose>("auto");
  const [model3DImageEnhancement, setModel3DImageEnhancement] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<PreviewResult>();
  const [history, setHistory] = useState<PreviewResult[]>([]);
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
  const templateCoverRequest = useRef(0);
  const templateCoverUrlRef = useRef<string | undefined>(undefined);
  const uploadInput = useRef<HTMLInputElement>(null);
  const modelReferenceTarget = useRef(0);
  const resultActions = useRef<HTMLDivElement>(null);
  const auth = useAuth();

  const builtInTemplateIds = new Set(ASSET_TEMPLATES.map((template) => template.id));
  const yoursTemplates = localTemplates.map(templateForGallery);
  const communityTemplates = exploreTemplates
    .filter((template) => template.author.id !== OPEN_GAME_TEMPLATE_AUTHOR.id
      && !builtInTemplateIds.has(template.id))
    .map(templateForGallery);
  const templates = [...yoursTemplates, ...communityTemplates];
  const selectedTemplate = templates.find((template) => template.id === templateIds[mode] && template.mode === mode);
  const activeTemplate = selectedTemplate ?? defaultTemplateForMode(mode);
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
  const canGenerate = mode === "image"
    ? Boolean(imagePrompt.trim() && selectedImageModel)
    : mode === "video"
      ? Boolean(videoPrompt.trim())
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
  }, [mode, templateIds, panelView, result?.run.id, selectedResult, imagePrompt, resolution, aspectRatio, outputs, videoPrompt, videoAspectRatio, videoResolution, videoDuration, model3D, model3DSource, model3DPrompt, model3DMultiView, model3DQuality, model3DTargetPolycount, model3DTexture, model3DPose, model3DImageEnhancement]);

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
      await Promise.all([loadImageConfig(), loadProjectList(), loadTemplates(), loadHistory()]);
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
    const available = [...localTemplates, ...exploreTemplates.filter((template) => !builtInTemplateIds.has(template.id))];
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

  async function loadHistory(): Promise<void> {
    try {
      const runs = await listToolRuns();
      const loaded = await Promise.allSettled(runs.map(async (run): Promise<PreviewResult> => ({
        run,
        urls: (await Promise.all(run.files.map((file) => getToolRunFile(run.id, file.name)))).map((blob) => URL.createObjectURL(blob)),
        title: run.title ?? defaultRunTitle(run.toolId),
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

  async function generate(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    if (!canGenerate || generating) return;
    setGenerating(true);
    setGenerationError(undefined);
    setActionStatus(undefined);
    setMenuOpen(false);
    setPanelView("history");
    try {
      let nextRun: ToolRun;
      if (mode === "image") {
        if (!selectedImageModel) throw new Error("Connect an image model before generating");
        nextRun = await runTool("generate-image", {
          prompt: imagePrompt.trim(), resolution, aspectRatio, outputs,
          ...(imageReferences.length ? { images: imageReferences } : {}),
        }, selectedTemplate?.name);
      } else if (mode === "video") {
        nextRun = await runTool("generate-video", {
          prompt: videoPrompt.trim(), duration: videoDuration, aspectRatio: videoAspectRatio, resolution: videoResolution,
          ...(videoReferences.length ? { images: videoReferences } : {}),
        }, selectedTemplate?.name);
      } else {
        const images = modelReferences
          .slice(0, !isMeshyT2 && model3DMultiView ? 4 : 1)
          .filter((image): image is PromptImage => image !== undefined);
        nextRun = await runTool("image-to-3d", {
          ...(model3DSource === "text" ? { prompt: model3DPrompt.trim() } : { images }),
          model: model3D,
          ...(isMeshyT2 ? { targetPolycount: model3DTargetPolycount } : { quality: model3DQuality }),
          texture: model3DTexture,
          pose: model3DPose,
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
      const blobs = await Promise.all(nextRun.files.map((file) => getToolRunFile(nextRun.id, file.name)));
      if (!mounted.current) return;
      const nextResult = { run: nextRun, urls: blobs.map((blob) => URL.createObjectURL(blob)), title: nextRun.title ?? defaultRunTitle(nextRun.toolId) };
      setResult(nextResult);
      addHistoryResult(nextResult);
      setSelectedResult(0);
    } catch (cause) {
      if (mounted.current) setGenerationError(errorMessage(cause));
    } finally {
      if (mounted.current) setGenerating(false);
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
    if (generating) return;
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
    if (generating || nextMode === mode) return;
    setMode(nextMode);
    setGenerationError(undefined);
    setReferenceError(undefined);
    setActionStatus(undefined);
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
      promptPlaceholder: activeTemplate.promptPlaceholder,
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
      video: { prompt: videoPrompt, resolution: videoResolution, aspectRatio: videoAspectRatio, duration: videoDuration },
      model3D: {
        prompt: model3DPrompt,
        model: model3D,
        source: model3DSource,
        multiView: model3DMultiView,
        quality: model3DQuality,
        targetPolycount: model3DTargetPolycount,
        texture: model3DTexture,
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
    setVideoResolution(draft.video.resolution);
    setVideoAspectRatio(draft.video.aspectRatio);
    setVideoDuration(draft.video.duration);
    setModel3DPrompt(draft.model3D.prompt);
    setModel3D(draft.model3D.model);
    setModel3DSource(draft.model3D.source);
    setModel3DMultiView(draft.model3D.multiView);
    setModel3DQuality(draft.model3D.quality);
    setModel3DTargetPolycount(draft.model3D.targetPolycount);
    setModel3DTexture(draft.model3D.texture);
    setModel3DPose(draft.model3D.pose);
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
    if (!files.length) return;
    try {
      if (mode === "image" && imageReferences.length + files.length > 14) throw new Error("Select up to 14 reference images");
      if (mode === "video" && videoReferences.length + files.length > VIDEO_REFERENCE_LIMIT) throw new Error(`Select up to ${VIDEO_REFERENCE_LIMIT} reference images`);
      const selectedFiles = files;
      const nextImages = await Promise.all(selectedFiles.map((file) => readImage(file, mode !== "3d")));
      if (!mounted.current) return;
      if (mode === "image") {
        setImageReferences((current) => [...current, ...nextImages]);
        setImageReferenceNames((current) => [...current, ...selectedFiles.map((file) => file.name)]);
      }
      else if (mode === "video") {
        setVideoReferences((current) => [...current, ...nextImages]);
        setVideoReferenceNames((current) => [...current, ...selectedFiles.map((file) => file.name)]);
      }
      setReferenceError(undefined);
    } catch (cause) {
      if (mounted.current) setReferenceError(errorMessage(cause));
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
                <ModeSwitcher mode={mode} disabled={generating} onChange={chooseMode} />
                {mode === "image" ? (
                  <>
                    <Field label="Model" htmlFor="asset-model">
                      {imagePhase === "loading" ? <p className="asset-inline-state"><LoaderCircle className="spin" size={13} />Loading models</p> : null}
                      {imagePhase === "error" ? <div className="asset-inline-error" role="alert"><span>{imageLoadError}</span><button type="button" onClick={() => void loadImageConfig()}><RefreshCw size={12} />Retry</button></div> : null}
                      {imagePhase === "ready" && imageModels.length ? <ModelSelect id="asset-model" value={imageModelKey} options={imageModels.map((model) => ({ value: modelKey(model), label: model.name }))} disabled={generating} onChange={chooseImageModel} /> : null}
                      {imagePhase === "ready" && !imageModels.length ? <p className="asset-inline-state">No image model is connected</p> : null}
                    </Field>
                    <PromptField id="asset-image-prompt" value={imagePrompt} disabled={generating} placeholder={activeTemplate.promptPlaceholder} onChange={setImagePrompt} />
                  </>
                ) : mode === "video" ? (
                  <>
                    <Field label="Model" htmlFor="asset-video-model"><ModelSelect id="asset-video-model" value={VIDEO_MODEL} options={VIDEO_MODEL_OPTIONS} disabled={generating} onChange={() => undefined} /></Field>
                    <PromptField id="asset-video-prompt" value={videoPrompt} disabled={generating} placeholder={activeTemplate.promptPlaceholder} onChange={setVideoPrompt} />
                  </>
                ) : (
                  <>
                    <Field label="Model" htmlFor="asset-3d-model"><ModelSelect id="asset-3d-model" value={model3D} options={MODEL_3D_OPTIONS} disabled={generating} onChange={setModel3D} /></Field>
                    <Model3DInputField
                      source={model3DSource}
                      prompt={model3DPrompt}
                      images={modelReferences}
                      imageNames={modelReferenceNames}
                      multiView={model3DMultiView}
                      allowMultiView={!isMeshyT2}
                      promptPlaceholder={activeTemplate.promptPlaceholder}
                      disabled={generating}
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

                {mode === "image" ? <ImageReferenceField images={imageReferences} names={imageReferenceNames} disabled={generating || !selectedImageModel?.supportsReferenceImage} onChoose={() => uploadInput.current?.click()} onRemove={(index) => {
                  setImageReferences((current) => current.filter((_, candidate) => candidate !== index));
                  setImageReferenceNames((current) => current.filter((_, candidate) => candidate !== index));
                  setReferenceError(undefined);
                }} /> : mode === "video" ? <ImageReferenceField images={videoReferences} names={videoReferenceNames} max={VIDEO_REFERENCE_LIMIT} disabled={generating} onChoose={() => uploadInput.current?.click()} onRemove={(index) => {
                  setVideoReferences((current) => current.filter((_, candidate) => candidate !== index));
                  setVideoReferenceNames((current) => current.filter((_, candidate) => candidate !== index));
                  setReferenceError(undefined);
                }} /> : null}
                {referenceError && (mode !== "3d" || model3DSource === "image") ? <p className="asset-field-error" role="alert">{referenceError}</p> : null}
                <input ref={uploadInput} hidden multiple={mode !== "3d"} type="file" accept={mode === "3d" ? "image/png,image/jpeg" : "image/png,image/jpeg,image/webp"} onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = "";
                  if (mode === "3d") void selectModelReference(modelReferenceTarget.current, files);
                  else void selectReference(files);
                }} />

                {mode === "image" && selectedImageModel ? (
                  <>
                    <OptionGroup label="Resolution" values={supportedImageResolutions} value={resolution} disabled={generating} onChange={chooseImageResolution} />
                    <OptionGroup label="Aspect ratio" values={supportedImageAspectRatios} value={aspectRatio} disabled={generating} onChange={chooseImageAspectRatio} />
                    <OptionGroup label="Outputs" values={IMAGE_OUTPUT_COUNTS} value={outputs} disabled={generating} isOptionDisabled={(value) => value > selectedImageModel.maxOutputs} onChange={setOutputs} />
                  </>
                ) : mode === "video" ? (
                  <>
                    <OptionGroup label="Resolution" values={VIDEO_RESOLUTIONS} value={videoResolution} disabled={generating} format={(value) => value.toUpperCase()} onChange={setVideoResolution} />
                    <OptionGroup label="Aspect ratio" values={VIDEO_ASPECT_RATIOS} value={videoAspectRatio} disabled={generating} format={(value) => value === "adaptive" ? "Auto" : value} onChange={setVideoAspectRatio} />
                    <RangeField label="Duration" value={videoDuration} min={4} max={15} disabled={generating} onChange={setVideoDuration} />
                  </>
                ) : mode === "3d" ? (
                  <div className="asset-3d-options">
                    {isMeshyT2
                      ? <PolyCountField value={model3DTargetPolycount} disabled={generating} onChange={setModel3DTargetPolycount} />
                      : <OptionGroup equal label="Quality" values={MODEL_3D_QUALITIES} value={model3DQuality} disabled={generating} format={titleCase} onChange={setModel3DQuality} />}
                    <ToggleField label="Texture" checked={model3DTexture} disabled={generating} onChange={setModel3DTexture} />
                    <OptionGroup equal label="Pose" values={MODEL_3D_POSES} value={model3DPose} disabled={generating} format={(value) => value === "auto" ? "None" : value === "a-pose" ? "A-Pose" : "T-Pose"} onChange={setModel3DPose} />
                    {model3DSource === "image" && !isMeshyT2 ? <ToggleField label="Image enhancement" checked={model3DImageEnhancement} disabled={generating} onChange={setModel3DImageEnhancement} /> : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="asset-config-actions">
              <button className="asset-save-template-button" type="button" aria-label="Save as template" title="Save as template" disabled={phase !== "ready" || generating || templateBusy} onClick={openTemplateDialog}>
                {templateBusy ? <LoaderCircle className="spin" size={15} /> : <Bookmark size={16} />}
              </button>
              <button className="asset-generate-button" type="submit" disabled={phase !== "ready" || !canGenerate || generating}>
                {generating ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
                {generating ? "Generating..." : "Generate"}
              </button>
            </div>
          </form>

          <section className="asset-result-panel" aria-label={panelView === "templates" ? "Asset templates" : "Generation history"}>
            <header><PanelViewSwitcher view={panelView} disabled={generating} onChange={setPanelView} /><div className="asset-result-actions" ref={resultActions}>{panelView === "history" && result ? <button type="button" aria-label="Result actions" aria-expanded={menuOpen} disabled={generating} onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={17} /></button> : null}{menuOpen && result && selectedFile && selectedUrl ? <div className="asset-result-menu" role="menu">
              <a href={selectedUrl} download={selectedFile.name} role="menuitem"><Download size={14} />Download</a>
              {projects.length ? <div className="asset-result-projects">
                <button type="button" role="menuitem" aria-haspopup="menu" disabled={adding}><FolderInput size={14} /><span>Add to Project</span><ChevronRight className="asset-result-menu-chevron" size={13} /></button>
                <div className="asset-result-submenu" role="menu">
                  {projects.map((project) => <button type="button" role="menuitem" key={project.id} disabled={adding} title={project.name} onClick={() => void addToProject(project)}><span>{project.name}</span></button>)}
                </div>
              </div> : null}
              {projectsError ? <button type="button" role="menuitem" onClick={() => void loadProjectList()}><RefreshCw size={14} />Retry projects</button> : null}
              <button type="button" role="menuitem" disabled={generating} onClick={() => void generate()}><RefreshCw size={14} />Regenerate</button>
            </div> : null}</div></header>
            <div className={`asset-result-canvas${panelView === "templates" ? " asset-template-gallery" : " asset-history-view"}${panelView === "history" && history.length ? " asset-history-grid" : ""}`}>
              {panelView === "templates" ? <TemplateGallery
                yours={yoursTemplates}
                explore={communityTemplates}
                selectedId={selectedTemplate?.id}
                busy={templateBusy || generating}
                onSelect={applyTemplate}
                onPublish={(template) => void shareTemplate(template)}
                onSetPublication={(template, status) => void setTemplatePublication(template, status)}
                onDelete={(template) => void deleteTemplate(template)}
              /> : null}
              {panelView === "history" && generating ? <div className="asset-result-empty"><LoaderCircle className="spin" size={28} /><strong>Generating your {mode === "3d" ? "model" : mode}</strong><span>This may take a moment.</span></div> : null}
              {panelView === "history" && !generating && generationError && !history.length ? <div className="asset-result-empty asset-result-error" role="alert"><strong>Generation failed</strong><span>{generationError}</span></div> : null}
              {panelView === "history" && !generating && !generationError && !history.length ? <div className="asset-result-empty"><span className="asset-result-empty-icon"><Sparkles size={24} /></span><strong>No history yet</strong><span>Generated assets from this session will appear here.</span></div> : null}
              {panelView === "history" && !generating && history.length ? history.flatMap((entry) => entry.urls.map((url, index) => {
                const selected = result?.run.id === entry.run.id && selectedResult === index;
                const resultMode = studioModeForTool(entry.run.toolId);
                return <button className={`asset-history-item${selected ? " is-selected" : ""}`} type="button" key={`${entry.run.id}:${index}`} aria-label={`Select ${entry.title} result`} onClick={() => { setResult(entry); setSelectedResult(index); setActionStatus(undefined); setMenuOpen(false); }}><span className="asset-history-preview"><ResultMedia mode={resultMode} url={url} label={entry.title} /></span><span className="asset-history-copy"><strong>{entry.title}</strong><small>{formatHistoryTime(entry.run.createdAt)}</small></span></button>;
              })) : null}
            </div>
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

function PanelViewSwitcher({ view, disabled, onChange }: { view: AssetPanelView; disabled: boolean; onChange: (view: AssetPanelView) => void }) {
  return <div className="asset-panel-switcher" aria-label="Asset Studio view">{(["templates", "history"] as const).map((value) => <button key={value} type="button" className={view === value ? "is-active" : undefined} aria-pressed={view === value} disabled={disabled} onClick={() => onChange(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>;
}

function ModeSwitcher({ mode, disabled, onChange }: { mode: StudioMode; disabled: boolean; onChange: (mode: StudioMode) => void }) {
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
  return <article className={`asset-template-card${selected ? " is-selected" : ""}${template.source === "builtIn" ? " is-official" : ""}${actionsOpen ? " is-menu-open" : ""}`}>
    <button className="asset-template-card-open" type="button" aria-label={`${template.name}: ${template.description}`} aria-pressed={selected} disabled={busy} onClick={() => onSelect(template)}>
      <TemplatePreview template={template} />
      <span className="asset-template-card-copy"><strong>{template.name}</strong>{template.source === "builtIn" && !template.author ? <small>OpenGame</small> : publication?.status === "listed" ? <small>Published</small> : publication ? <small>Unlisted</small> : null}</span>
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
    {template.author && template.stats ? <CommunityMeta type="template" id={template.id} author={template.author} stats={template.stats} useLabel="uses" verified={template.source === "builtIn"} /> : null}
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

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return <div className="asset-field"><label htmlFor={htmlFor}>{label}</label>{children}</div>;
}

function ModelSelect<T extends string>({ id, value, options, disabled, onChange }: { id: string; value: T; options: readonly { value: T; label: string }[]; disabled: boolean; onChange: (value: T) => void }) {
  return <div className="asset-select-wrap"><select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown size={14} /></div>;
}

function PromptField({ id, value, placeholder, maxLength = 2000, disabled, onChange }: { id: string; value: string; placeholder: string; maxLength?: number; disabled: boolean; onChange: (value: string) => void }) {
  return <Field label="Prompt" htmlFor={id}><PromptControl id={id} value={value} placeholder={placeholder} maxLength={maxLength} disabled={disabled} onChange={onChange} /></Field>;
}

function PromptControl({ id, value, placeholder, maxLength, ariaLabel, disabled, onChange }: { id: string; value: string; placeholder: string; maxLength: number; ariaLabel?: string; disabled: boolean; onChange: (value: string) => void }) {
  return <div className="asset-prompt-wrap"><textarea id={id} aria-label={ariaLabel} maxLength={maxLength} value={value} placeholder={placeholder} disabled={disabled} onChange={(event) => onChange(event.target.value)} /><span>{value.length.toLocaleString()} / {maxLength.toLocaleString()}</span></div>;
}

function Model3DInputField({ source, prompt, images, imageNames, multiView, allowMultiView, promptPlaceholder, disabled, onSourceChange, onPromptChange, onMultiViewChange, onChooseImage, onSelectFiles, onRemoveImage }: { source: Model3DSource; prompt: string; images: (PromptImage | undefined)[]; imageNames: (string | undefined)[]; multiView: boolean; allowMultiView: boolean; promptPlaceholder: string; disabled: boolean; onSourceChange: (source: Model3DSource) => void; onPromptChange: (prompt: string) => void; onMultiViewChange: (value: boolean) => void; onChooseImage: (index: number) => void; onSelectFiles: (index: number, files: File[]) => void; onRemoveImage: (index: number) => void }) {
  return <div className={`asset-3d-input is-${source}`}><div className="asset-3d-input-header"><span>Input</span><SourceSwitch value={source} disabled={disabled} onChange={onSourceChange} /></div><div className="asset-3d-input-body">{source === "text"
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

function ResultMedia({ mode, url, label }: { mode: StudioMode; url: string; label: string }) {
  if (mode === "3d") return <ModelPreview source={url} label="Generated 3D model" minHeight={420} />;
  if (mode === "video") return <video src={url} controls preload="metadata" />;
  return <img src={url} alt={label} />;
}

function OptionGroup<T extends string | number>({ label, values, value, disabled, equal = false, isOptionDisabled, format, onChange }: { label: string; values: readonly T[]; value: T; disabled: boolean; equal?: boolean; isOptionDisabled?: (value: T) => boolean; format?: (value: T) => string; onChange: (value: T) => void }) {
  return <fieldset className={`asset-option-group${equal ? " is-equal" : ""}`} disabled={disabled}><legend>{label}</legend><div style={equal ? { gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))` } : undefined}>{values.map((option) => <button type="button" key={option} className={option === value ? "is-active" : undefined} aria-pressed={option === value} disabled={disabled || isOptionDisabled?.(option)} onClick={() => onChange(option)}>{format ? format(option) : option}</button>)}</div></fieldset>;
}

function RangeField({ label, value, min, max, disabled, onChange }: { label: string; value: number; min: number; max: number; disabled: boolean; onChange: (value: number) => void }) {
  const style = { "--asset-range-progress": `${((value - min) / (max - min)) * 100}%` } as CSSProperties;
  return <div className="asset-range-field"><div><label htmlFor="asset-video-duration">{label}</label><output htmlFor="asset-video-duration">{value}s</output></div><input id="asset-video-duration" type="range" value={value} min={min} max={max} step={1} disabled={disabled} style={style} onChange={(event) => onChange(Number(event.target.value))} /><div className="asset-range-bounds"><span>{min}s</span><span>{max}s</span></div></div>;
}

function PolyCountField({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (value: number) => void }) {
  const min = 100;
  const max = 15_000;
  const style = { "--asset-range-progress": `${((value - min) / (max - min)) * 100}%` } as CSSProperties;
  const update = (next: number) => {
    if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, Math.round(next))));
  };
  return <div className="asset-number-range-field"><div><label htmlFor="asset-3d-polycount">Poly Count</label><input aria-label="Poly count value" type="number" value={value} min={min} max={max} step={100} disabled={disabled} onChange={(event) => update(event.target.valueAsNumber)} /></div><input id="asset-3d-polycount" type="range" value={value} min={min} max={max} step={100} disabled={disabled} style={style} onChange={(event) => update(event.target.valueAsNumber)} /><div className="asset-range-bounds"><span>{min.toLocaleString()}</span><span>{max.toLocaleString()}</span></div></div>;
}

function ToggleField({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return <div className="asset-toggle-field"><span>{label}</span><button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button></div>;
}

function titleCase(value: string): string {
  return value[0]?.toUpperCase() + value.slice(1);
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

function formatHistoryTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
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
