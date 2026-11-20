import type { AgentNotice, AgentNoticeKind, AgentNoticesResponse } from "../shared/agent-notices.js";
import { DEFAULT_AGENT_NOTIFICATION_PREFERENCES, type AgentNotificationPermission, type AgentNotificationPreferences, type AgentNotificationTarget, type AgentResultRead } from "../shared/agent-notifications.js";

const POLL_MS = 2_000;

export interface AgentNotificationHost {
  /** Notices after `after`, or `undefined` while the daemon cannot answer. */
  notices(after: number): Promise<AgentNoticesResponse | undefined>;
  /** Whether the main window is open, visible and focused. */
  focused(): boolean;
  /** The system permission, read before showing new notices. */
  permission(): Promise<AgentNotificationPermission>;
  show(notification: { title: string; body: string }, onClick: () => void): { close(): void } | undefined;
  /**
   * How many conversations wait for the user, as the Dock badge on macOS or a
   * taskbar overlay on Windows; `description` names it for screen readers.
   */
  showWaiting(count: number, description: string): void;
  /**
   * How many finished or failed turns arrived while the window was in the
   * background and were not read, for badges that survive the window hiding.
   */
  showUnread?(count: number, description: string): void;
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
  #unreadBadge = 0;
  /** Finished or failed turns the user has not read, one entry per conversation. */
  readonly #unread = new Map<string, number>();
  /** The renderer can observe a result or a new daemon epoch before the desktop poll does. */
  readonly #seen = new Map<string, Map<string, number>>();

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
      for (const epoch of this.#seen.keys()) {
        if (epoch !== page.epoch) this.#seen.delete(epoch);
      }
      if (!first) this.#closeAll();
    } else {
      const fresh = page.notices.filter((notice) => notice.seq > this.#cursor.after);
      this.#cursor = { epoch: page.epoch, after: Math.max(this.#cursor.after, page.latestSeq) };
      const waiting = new Set(page.waiting.map((item) => item.id));
      // A request answered or cancelled since the last poll is no longer news.
      const news = fresh.filter((notice) => !notice.waitingId || waiting.has(notice.waitingId));
      const permission = news.length && this.#preferences.enabled ? await this.#permission() : undefined;
      for (const notice of news) this.#announce(notice, page.epoch, permission);
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

  markResultRead(result: AgentResultRead): void {
    const { epoch, eventId } = result;
    const key = conversationKey(result);
    let seen = this.#seen.get(epoch);
    if (!seen) this.#seen.set(epoch, seen = new Map());
    if (eventId <= (seen.get(key) ?? 0)) return;
    seen.set(key, eventId);
    if (epoch !== this.#cursor.epoch) return;
    const unread = this.#unread.get(key);
    if (unread === undefined || unread > eventId) return;
    this.#unread.delete(key);
    this.#setUnread(this.#unread.size);
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

  #announce(notice: AgentNotice, epoch: string, permission: AgentNotificationPermission | undefined): void {
    const label = `Agent notice ${notice.seq} (${notice.kind}, project ${notice.projectId})`;
    if (!this.#preferences.enabled) {
      this.host.log?.(`${label} not shown: notifications are off`);
      return;
    }
    if (permission === "denied") {
      // The system would drop it silently while Electron still reports it as shown.
      this.host.log?.(`${label} not shown: the system blocks notifications`);
    }
    const focused = this.host.focused();
    const waits = isWaiting(notice.kind);
    const target = { projectId: notice.projectId, conversationId: notice.conversationId };
    const key = conversationKey(target);
    if (!waits && notice.resultEventId !== undefined) {
      const seen = this.#seen.get(epoch)?.get(key) ?? 0;
      // A read can precede this poll; a delayed result can follow a newer one.
      if (notice.resultEventId <= Math.max(seen, this.#unread.get(key) ?? 0)) return;
      if (!focused) {
        this.#unread.set(key, notice.resultEventId);
        this.#setUnread(this.#unread.size);
      }
    }
    if (permission === "denied") return;
    if (focused && (!waits || this.#viewing(notice))) {
      this.host.log?.(`${label} not shown: the window is in front`);
      return;
    }
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
    this.host.showWaiting(count, this.#preferences.text.waiting);
  }

  #setUnread(count: number): void {
    if (count === this.#unreadBadge || !this.host.showUnread) return;
    this.#unreadBadge = count;
    this.host.showUnread(count, this.#preferences.text.unread);
  }

  #close(key: string): void {
    const shown = this.#shown.get(key);
    if (!shown) return;
    this.#shown.delete(key);
    shown.notification.close();
  }

  #closeAll(): void {
    for (const key of [...this.#shown.keys()]) this.#close(key);
    this.#unread.clear();
    this.#setUnread(0);
  }
}

/**
 * A compact accent dot as a premultiplied BGRA bitmap. Windows places this
 * overlay on the taskbar icon, so keeping the dot centered avoids a second
 * oversized icon inside the overlay slot.
 */
export function waitingDotBitmap(size = 16): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const center = size / 2;
  for (let y = Math.max(0, Math.floor(center - 3)); y <= Math.min(size - 1, Math.ceil(center + 3)); y += 1) {
    for (let x = Math.max(0, Math.floor(center - 3)); x <= Math.min(size - 1, Math.ceil(center + 3)); x += 1) {
      // One pixel of soft edge keeps the circle from looking jagged.
      const coverage = Math.min(1, Math.max(0, 3 - Math.hypot(x + 0.5 - center, y + 0.5 - center)));
      if (!coverage) continue;
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(0x4d * coverage);
      pixels[offset + 1] = Math.round(0x48 * coverage);
      pixels[offset + 2] = Math.round(0xe5 * coverage);
      pixels[offset + 3] = Math.round(0xff * coverage);
    }
  }
  return pixels;
}

/**
 * A small accent dot over the original icon. Tray icons are too small for a
 * readable number, so the exact count is included in the tray tooltip.
 */
export function trayBadgeBitmap(base: Buffer, { width, height }: { width: number; height: number }): Buffer {
  const pixels = Buffer.from(base);
  if (pixels.length !== width * height * 4) throw new Error("Invalid tray icon bitmap");
  const centerX = width - 4;
  const centerY = 4;
  for (let y = Math.max(0, centerY - 3); y <= Math.min(height - 1, centerY + 3); y += 1) {
    for (let x = Math.max(0, centerX - 3); x <= Math.min(width - 1, centerX + 3); x += 1) {
      if (Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY) > 3) continue;
      const at = (y * width + x) * 4;
      pixels[at] = 0x4d;
      pixels[at + 1] = 0x48;
      pixels[at + 2] = 0xe5;
      pixels[at + 3] = 0xff;
    }
  }
  return pixels;
}

function isWaiting(kind: AgentNoticeKind): boolean {
  return kind === "approval" || kind === "question" || kind === "plan";
}

function conversationKey(target: AgentNotificationTarget): string {
  return `${target.projectId}:${target.conversationId}`;
}
