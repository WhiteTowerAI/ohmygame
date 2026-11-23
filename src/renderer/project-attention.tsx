import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import type { AgentNotice, AgentNoticesResponse } from "../shared/agent-notices.js";
import { request } from "./api.js";
import { DangerCircle } from "./icons.js";
import { t } from "./i18n.js";
import { useRuntimeConnection } from "./runtime-connection.js";
import "./project-attention.css";

type Attention = "unread" | "waiting";
type Target = Pick<AgentNotice, "projectId" | "conversationId">;

function conversationKey({ projectId, conversationId }: Target): string {
  return `${projectId}:${conversationId}`;
}

/** One renderer session owns the read state across all routes and layouts. */
class ProjectAttention {
  #epoch: string | undefined;
  #after = 0;
  readonly #seen = new Map<string, number>();
  readonly #unread = new Map<string, AgentNotice>();
  #waiting: AgentNoticesResponse["waiting"] = [];
  #projects = new Map<string, Attention>();
  #conversations = new Map<string, Attention>();
  readonly #listeners = new Set<() => void>();

  get after(): number { return this.#after; }
  epoch = () => this.#epoch;
  project = (projectId: string) => this.#projects.get(projectId);
  conversation = (target: Target) => this.#conversations.get(conversationKey(target));
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  receive(page: AgentNoticesResponse): void {
    if (this.#epoch !== page.epoch) {
      this.#seen.clear();
      this.#epoch = page.epoch;
      this.#unread.clear();
    } else {
      for (const notice of page.notices) {
        if (notice.seq <= this.#after || (notice.kind !== "completed" && notice.kind !== "failed")) continue;
        const key = conversationKey(notice);
        if (notice.resultEventId !== undefined && notice.resultEventId > (this.#seen.get(key) ?? 0)) {
          const currentEventId = this.#unread.get(key)?.resultEventId ?? 0;
          // A delayed planning result can arrive after a newer turn's result.
          if (notice.resultEventId > currentEventId) this.#unread.set(key, notice);
        }
      }
    }
    this.#after = page.latestSeq;
    this.#waiting = page.waiting;
    this.#publish();
  }

  viewed(target: Target, epoch: string | undefined, eventId: number): void {
    if (epoch === undefined || this.#epoch !== epoch) return;
    const key = conversationKey(target);
    if (eventId <= (this.#seen.get(key) ?? 0)) return;
    this.#seen.set(key, eventId);
    void window.ohMyGameDesktop?.notifications?.markResultRead({ ...target, epoch, eventId }).catch(() => undefined);
    const unread = this.#unread.get(key)?.resultEventId;
    if (unread === undefined || unread > eventId) return;
    this.#unread.delete(key);
    this.#publish();
  }

  #publish(): void {
    const projects = new Map<string, Attention>();
    const conversations = new Map<string, Attention>();
    for (const [key, { projectId }] of this.#unread) {
      projects.set(projectId, "unread");
      conversations.set(key, "unread");
    }
    for (const target of this.#waiting) {
      projects.set(target.projectId, "waiting");
      conversations.set(conversationKey(target), "waiting");
    }
    this.#conversations = conversations;
    this.#projects = projects;
    for (const listener of this.#listeners) listener();
  }
}

const AttentionContext = createContext(new ProjectAttention());

export function ProjectAttentionProvider({ children }: { children: ReactNode }) {
  const [attention] = useState(() => new ProjectAttention());
  const { status, generation } = useRuntimeConnection();
  useEffect(() => {
    if (status !== "ready") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
        const page = await request<AgentNoticesResponse>(`/agent-notices?after=${attention.after}`, { signal });
        if (!controller.signal.aborted) attention.receive(page);
      } catch {
        // Preserve the previous state while the daemon reconnects.
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2_000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [attention, generation, status]);
  return <AttentionContext.Provider value={attention}>{children}</AttentionContext.Provider>;
}

/** Record only a committed conversation cursor while the live timeline is in view. */
export function useViewedProjectResult(projectId: string, conversationId: string | undefined, eventEpoch: string | undefined, eventId: number, visible: boolean, following: RefObject<boolean>): () => void {
  const attention = useContext(AttentionContext);
  const epoch = useSyncExternalStore(attention.subscribe, attention.epoch);
  const viewed = useCallback(() => {
    if (!visible || !conversationId || !following.current) return;
    if (document.visibilityState === "visible" && document.hasFocus()) attention.viewed({ projectId, conversationId }, eventEpoch, eventId);
  }, [attention, conversationId, eventEpoch, eventId, following, projectId, visible]);
  useEffect(() => {
    viewed();
  }, [epoch, viewed]);
  useEffect(() => {
    if (!visible || !conversationId) return;
    window.addEventListener("focus", viewed);
    document.addEventListener("visibilitychange", viewed);
    return () => {
      window.removeEventListener("focus", viewed);
      document.removeEventListener("visibilitychange", viewed);
    };
  }, [conversationId, viewed, visible]);
  return viewed;
}

export function useProjectAttention(projectId: string, conversationId?: string): Attention | undefined {
  const attention = useContext(AttentionContext);
  return useSyncExternalStore(attention.subscribe, () => conversationId
    ? attention.conversation({ projectId, conversationId }) : attention.project(projectId));
}

export function attentionLabel(attention: Attention | undefined): string | undefined {
  return attention ? t(`projectAttention.${attention}`) : undefined;
}

export function ProjectAttentionMark({ attention }: { attention: Attention | undefined }) {
  if (!attention) return null;
  return (
    <span aria-hidden="true" title={attentionLabel(attention)} className={`project-attention-mark is-${attention}`}>
      {attention === "waiting" ? <DangerCircle size={12} /> : null}
    </span>
  );
}
