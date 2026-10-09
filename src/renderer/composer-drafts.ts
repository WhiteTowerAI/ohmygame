import type { PluginMention, PromptContext, PromptReference } from "../shared/contracts.js";
import type { ChatReference } from "./chat-reference.js";
import type { ComposerAttachment } from "./composer-attachments.js";
import { extractLeadingPluginMention, parseSkillInvocation } from "./composer-mentions.js";

export interface ComposerDraft {
  prompt: string;
  mentions: PluginMention[];
}

export interface ComposerDraftScope {
  projectId: string;
  conversationId: string;
}

export interface SavedComposerDraft extends ComposerDraft {
  selectedSkill?: string;
  selectedPlugin?: PluginMention;
  attachments: ComposerAttachment[];
  reference?: ChatReference;
  designReference?: { references: PromptReference[]; context: PromptContext };
  planning: boolean;
  /** These fields survive remounting, but are never restored after a reload. */
  submitting: boolean;
  focusRequestId?: string;
}

export interface ComposerDraftSession {
  getSnapshot: () => SavedComposerDraft;
  subscribe: (listener: () => void) => () => void;
  update: (patch: Partial<SavedComposerDraft> | ((current: SavedComposerDraft) => Partial<SavedComposerDraft>)) => void;
  clearSubmitted: (submitted: SavedComposerDraft) => boolean;
  insertPrompt: (text: string) => void;
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const STORAGE_PREFIX = "ohmygame:composer-draft:v1:";

/** A session belongs to a conversation, rather than to a mounted input box. */
export function createComposerDraftStore(storage?: DraftStorage) {
  const sessions = new Map<string, { session: ComposerDraftSession; forget: () => void }>();

  function get(scope?: ComposerDraftScope, initialDraft?: ComposerDraft, planning = false): ComposerDraftSession {
    const key = scope ? `${projectPrefix(scope.projectId)}${encodeURIComponent(scope.conversationId)}` : undefined;
    const existing = key ? sessions.get(key) : undefined;
    if (existing) return existing.session;

    const skill = parseSkillInvocation(initialDraft?.prompt ?? "");
    const plugin = extractLeadingPluginMention(skill?.prompt ?? initialDraft?.prompt ?? "", initialDraft?.mentions ?? []);
    const restored = readDraft(storage, key);
    let snapshot: SavedComposerDraft = {
      prompt: plugin.prompt,
      mentions: initialDraft?.mentions ?? [],
      selectedSkill: skill?.name,
      selectedPlugin: plugin.mention,
      planning,
      ...restored,
      attachments: [],
      submitting: false,
    };
    const listeners = new Set<() => void>();
    let active = true;
    let serializedDraft = serializeDraft(snapshot);

    const session: ComposerDraftSession = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      update: (patch) => {
        if (!active) return;
        const changes = typeof patch === "function" ? patch(snapshot) : patch;
        if (Object.entries(changes).every(([field, value]) => Object.is(snapshot[field as keyof SavedComposerDraft], value))) return;
        snapshot = { ...snapshot, ...changes };
        const serialized = serializeDraft(snapshot);
        if (serialized !== serializedDraft) {
          serializedDraft = serialized;
          saveDraft(storage, key, serialized);
        }
        for (const listener of listeners) listener();
      },
      clearSubmitted: (submitted) => {
        // Mode and sending status can change while the server accepts a prompt.
        // Only clear the message that was sent, never a newer message or reference.
        if (!active || !sameMessage(snapshot, submitted)) return false;
        session.update({ prompt: "", mentions: [], selectedSkill: undefined, selectedPlugin: undefined,
          attachments: [], reference: undefined, designReference: undefined, focusRequestId: undefined });
        return true;
      },
      insertPrompt: (text) => {
        session.update((current) => ({
          prompt: current.prompt.trim() ? `${current.prompt.trimEnd()}\n${text}` : text,
          focusRequestId: crypto.randomUUID(),
        }));
      },
    };

    if (key) {
      sessions.set(key, {
        session,
        forget: () => {
          active = false;
          snapshot = { prompt: "", mentions: [], attachments: [], planning: false, submitting: false };
          for (const listener of listeners) listener();
        },
      });
      // Preserve initial plugin/skill drafts even if the input is never edited.
      if (!restored && serializedDraft !== null) saveDraft(storage, key, serializedDraft);
    }
    return session;
  }

  function deleteProject(projectId: string): void {
    const prefix = projectPrefix(projectId);
    for (const [key, entry] of sessions) {
      if (!key.startsWith(prefix)) continue;
      entry.forget();
      sessions.delete(key);
    }
    try {
      if (!storage) return;
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
      for (const key of keys) if (key?.startsWith(prefix)) storage.removeItem(key);
    } catch { /* Memory drafts are still cleared when storage is unavailable. */ }
  }

  return { get, deleteProject };
}

function projectPrefix(projectId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(projectId)}:`;
}

function sameMessage(left: SavedComposerDraft, right: SavedComposerDraft): boolean {
  return left.prompt === right.prompt && left.mentions === right.mentions
    && left.selectedSkill === right.selectedSkill && left.selectedPlugin === right.selectedPlugin
    && left.attachments === right.attachments && left.reference === right.reference
    && left.designReference === right.designReference;
}

function serializeDraft(draft: SavedComposerDraft): string | null {
  if (!draft.prompt && !draft.selectedSkill && !draft.selectedPlugin && !draft.reference && !draft.designReference && !draft.planning) return null;
  const { prompt, mentions, selectedSkill, selectedPlugin, reference, designReference, planning } = draft;
  return JSON.stringify({ version: 1, prompt, mentions, selectedSkill, selectedPlugin, reference, designReference, planning });
}

function saveDraft(storage: DraftStorage | undefined, key: string | undefined, serialized: string | null): void {
  if (!storage || !key) return;
  try {
    if (serialized === null) storage.removeItem(key);
    else storage.setItem(key, serialized);
  } catch { /* Complete drafts, including File objects, remain available in memory. */ }
}

function readDraft(storage: DraftStorage | undefined, key: string | undefined): Partial<SavedComposerDraft> | undefined {
  if (!storage || !key) return;
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (!isRecord(value) || value.version !== 1 || typeof value.prompt !== "string" || !Array.isArray(value.mentions) || typeof value.planning !== "boolean") return;
    const design = value.designReference;
    const context = isRecord(design) ? design.context : undefined;
    return {
      prompt: value.prompt,
      mentions: value.mentions.filter(isPluginMention),
      selectedSkill: typeof value.selectedSkill === "string" ? value.selectedSkill : undefined,
      selectedPlugin: isPluginMention(value.selectedPlugin) ? value.selectedPlugin : undefined,
      planning: value.planning,
      reference: isRecord(value.reference) && typeof value.reference.text === "string" ? { text: value.reference.text } : undefined,
      designReference: isRecord(design) && Array.isArray(design.references)
        && design.references.every((ref) => isRecord(ref) && ref.type === "workspace-file" && typeof ref.path === "string")
        && isRecord(context) && context.kind === "design-document" && typeof context.label === "string" && typeof context.text === "string"
        ? { references: design.references as PromptReference[], context: { kind: context.kind, label: context.label, text: context.text } }
        : undefined,
    };
  } catch { /* Corrupt or unavailable storage must not prevent composing a message. */ }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPluginMention(value: unknown): value is PluginMention {
  return isRecord(value) && typeof value.name === "string" && typeof value.displayName === "string" && typeof value.marketplaceId === "string";
}

function browserStorage(): DraftStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export const composerDrafts = createComposerDraftStore(browserStorage());
