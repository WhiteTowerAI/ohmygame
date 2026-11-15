/** Native API 2.5: available only in the app host with the sessions grant. */
export interface SessionTarget {
  projectId: string;
  conversationId: string;
}

export type PluginSessionRequest =
  | { operation: "projects" }
  | { operation: "conversations" | "create"; projectId: string }
  | ({ operation: "read" | "settings" } & SessionTarget)
  | ({ operation: "stop"; turnId?: string } & SessionTarget)
  | ({
      operation: "model";
      model: { provider: string; id: string };
    } & SessionTarget)
  | ({
      operation: "reasoning";
      model: { provider: string; id: string };
      level: string;
    } & SessionTarget)
  | ({ operation: "send"; text: string } & SessionTarget)
  | { operation: "events"; projectId: string; after?: string; waitMs?: number };

export interface PluginSessionMessage {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  text: string;
  source?: { plugin: string };
  /** Assistant outcome is retained even when its text is empty. */
  status?: "inProgress" | "completed" | "cancelled" | "interrupted" | "failed";
  error?: { message: string; code?: string };
}

export interface PluginSessionResults {
  /** API 2.6: configured, visible models for this conversation's accounts. */
  settings: {
    models: {
      provider: string;
      id: string;
      name: string;
      providerName: string;
      levels: string[];
    }[];
    model?: { provider: string; id: string };
    level?: string;
    busy: boolean;
    loading: boolean;
    truncated: boolean;
  };
  model: { changed: true };
  reasoning: { changed: true };
  projects: { projects: { id: string; name: string }[]; truncated: boolean };
  conversations: {
    conversations: { id: string; title: string }[];
    truncated: boolean;
  };
  create: { id: string };
  read: {
    messages: PluginSessionMessage[];
    truncated: boolean;
    status: string;
    /** Pending decisions must be made by a person in OhMyGame. */
    needsApproval: boolean;
    cursor: string;
  };
  /** Acceptance, not completion. Never retry automatically after a lost reply. */
  send: { turnId: string };
  stop: { stopped: boolean };
  events: {
    cursor: string;
    /** Re-read the snapshot: the cursor predates this daemon or the replay buffer. */
    reset: boolean;
    events: {
      type: string;
      conversationId?: string;
      turnId?: string;
      timestamp: string;
    }[];
  };
}

export interface PluginSessions {
  /** Cancellation gives up the request; an accepted agent turn continues. */
  request<R extends PluginSessionRequest>(
    request: R,
    options?: { signal?: AbortSignal },
  ): Promise<PluginSessionResults[R["operation"]]>;
}
