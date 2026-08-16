const STORAGE_KEY = "open-game-pending-publish";
const MAX_AGE_MS = 15 * 60 * 1_000;

interface PendingPublish {
  projectId: string;
  createdAt: number;
}

export function rememberPendingPublish(storage: Storage, projectId: string, now = Date.now()): void {
  storage.setItem(STORAGE_KEY, JSON.stringify({ projectId, createdAt: now } satisfies PendingPublish));
}

export function takePendingPublish(storage: Storage, projectId: string, now = Date.now()): boolean {
  const value = storage.getItem(STORAGE_KEY);
  if (!value) return false;
  storage.removeItem(STORAGE_KEY);
  try {
    const pending = JSON.parse(value) as Partial<PendingPublish>;
    return pending.projectId === projectId && typeof pending.createdAt === "number" && now - pending.createdAt <= MAX_AGE_MS;
  } catch {
    return false;
  }
}

export function forgetPendingPublish(storage: Storage): void {
  storage.removeItem(STORAGE_KEY);
}
