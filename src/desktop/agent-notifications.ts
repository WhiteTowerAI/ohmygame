import type { AgentNotice, AgentNoticeKind, AgentNoticesResponse } from "../shared/agent-notices.js";
import { DEFAULT_AGENT_NOTIFICATION_PREFERENCES, type AgentNotificationPermission, type AgentNotificationPreferences, type AgentNotificationTarget } from "../shared/agent-notifications.js";

const POLL_MS = 2_000;

export interface AgentNotificationHost {
  /** Notices after `after`, or `undefined` while the daemon cannot answer. */
  notices(after: number): Promise<AgentNoticesResponse | undefined>;
  /** Whether the main window is open, visible and focused. */
  focused(): boolean;
  /** The system permission, read before showing new notices. */
  permission(): Promise<AgentNotificationPermission>;
  show(notification: { title: string; body: string }, onClick: () => void): { close(): void } | undefined;
  setBadgeCount(count: number): void;
  /** Asks for attention once, such as one bounce of the Dock icon. */
  requestAttention(): void;
  open(target: AgentNotificationTarget): void;
  /** One line per notice, with IDs only, for the desktop log. */
  log?(message: string): void;
}

interface Shown {
  notification: { close(): void };
  target: AgentNotificationTarget;
  waitingId?: string;
}

/**
 * Turns the daemon's agent notices into system notifications. It runs in the
 * main process so notices still arrive while the window is closed.
 *
 * A request, question or plan is shown unless the user is looking at that
 * conversation; a finished or failed turn only while the window is not in
 * front, since the conversation already shows it.
 */
export class AgentNotifications {
  #cursor: { epoch: string | null; after: number } = { epoch: null, after: 0 };
  #view: AgentNotificationTarget | null = null;
  #preferences: AgentNotificationPreferences = DEFAULT_AGENT_NOTIFICATION_PREFERENCES;
  /** One notification per conversation: a newer notice replaces the older one. */
  readonly #shown = new Map<string, Shown>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #badge = 0;

  constructor(private readonly host: AgentNotificationHost, private readonly pollMs = POLL_MS) {}

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const tick = async () => {
      await this.poll();
      if (this.#running) this.#timer = setTimeout(() => void tick(), this.pollMs);
    };
    void tick();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async poll(): Promise<void> {
    let page: AgentNoticesResponse | undefined;
    try {
      page = await this.host.notices(this.#cursor.after);
    } catch {
      return;
    }
    if (!page) return;
    if (page.epoch !== this.#cursor.epoch) {
      // The daemon started again: what it recorded before this reader was listening is not news.
      const first = this.#cursor.epoch === null;
      this.#cursor = { epoch: page.epoch, after: page.latestSeq };
      if (!first) this.#closeAll();
    } else {
      const fresh = page.notices.filter((notice) => notice.seq > this.#cursor.after);
      this.#cursor = { epoch: page.epoch, after: Math.max(this.#cursor.after, page.latestSeq) };
      const waiting = new Set(page.waiting.map((item) => item.id));
      // A request answered or cancelled since the last poll is no longer news.
      const news = fresh.filter((notice) => !notice.waitingId || waiting.has(notice.waitingId));
      const permission = news.length && this.#preferences.enabled ? await this.#permission() : undefined;
      for (const notice of news) this.#announce(notice, permission);
    }
    this.#sync(page.waiting);
  }

  /** The conversation the main window shows, or `null` when it shows none. */
  setView(view: AgentNotificationTarget | null): void {
    this.#view = view;
    this.focusChanged();
  }

  /** Called when the main window gains or loses focus. */
  focusChanged(): void {
    if (this.#view && this.host.focused()) this.#close(conversationKey(this.#view));
  }

  setPreferences(preferences: AgentNotificationPreferences): void {
    this.#preferences = preferences;
    if (!preferences.enabled) {
      this.#closeAll();
      this.#setBadge(0);
    }
  }

  async #permission(): Promise<AgentNotificationPermission | undefined> {
    try {
      return await this.host.permission();
    } catch {
      return undefined;
    }
  }

  #announce(notice: AgentNotice, permission: AgentNotificationPermission | undefined): void {
    const label = `Agent notice ${notice.seq} (${notice.kind}, project ${notice.projectId})`;
    if (!this.#preferences.enabled) {
      this.host.log?.(`${label} not shown: notifications are off`);
      return;
    }
    if (permission === "denied") {
      // The system would drop it silently while Electron still reports it as shown.
      this.host.log?.(`${label} not shown: the system blocks notifications`);
      return;
    }
    const focused = this.host.focused();
    const waits = isWaiting(notice.kind);
    if (focused && (!waits || this.#viewing(notice))) {
      this.host.log?.(`${label} not shown: the window is in front`);
      return;
    }
    const target = { projectId: notice.projectId, conversationId: notice.conversationId };
    const key = conversationKey(target);
    this.#close(key);
    const text = this.#preferences.text;
    const notification = this.host.show({
      title: notice.projectName ?? text.fallbackTitle,
      body: text[notice.kind],
    }, () => {
      this.#shown.delete(key);
      this.host.open(target);
    });
    if (!notification) {
      this.host.log?.(`${label} not shown: notifications are not supported`);
      return;
    }
    this.host.log?.(`${label} sent to the system`);
    this.#shown.set(key, { notification, target, ...(notice.waitingId ? { waitingId: notice.waitingId } : {}) });
    if (waits && !focused) this.host.requestAttention();
  }

  /** Withdraws notifications for what was answered elsewhere and counts what still waits. */
  #sync(waiting: AgentNoticesResponse["waiting"]): void {
    const ids = new Set(waiting.map((item) => item.id));
    for (const [key, shown] of this.#shown) {
      if (shown.waitingId && !ids.has(shown.waitingId)) this.#close(key);
    }
    this.#setBadge(this.#preferences.enabled ? new Set(waiting.map(conversationKey)).size : 0);
  }

  #viewing(notice: AgentNotice): boolean {
    return this.#view?.projectId === notice.projectId && this.#view.conversationId === notice.conversationId;
  }

  #setBadge(count: number): void {
    if (count === this.#badge) return;
    this.#badge = count;
    this.host.setBadgeCount(count);
  }

  #close(key: string): void {
    const shown = this.#shown.get(key);
    if (!shown) return;
    this.#shown.delete(key);
    shown.notification.close();
  }

  #closeAll(): void {
    for (const key of [...this.#shown.keys()]) this.#close(key);
  }
}

function isWaiting(kind: AgentNoticeKind): boolean {
  return kind === "approval" || kind === "question" || kind === "plan";
}

function conversationKey(target: AgentNotificationTarget): string {
  return `${target.projectId}:${target.conversationId}`;
}
