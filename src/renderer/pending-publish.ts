const STORAGE_KEY = "ohmygame-pending-publish";
const MAX_AGE_MS = 15 * 60 * 1_000;

interface PendingPublish {
  projectId: string;
  createdAt: number;
  title: string;
  description: string;
}

export function rememberPendingPublish(storage: Storage, projectId: string, details: { title: string; description: string }, now = Date.now()): void {
  storage.setItem(STORAGE_KEY, JSON.stringify({ projectId, createdAt: now, ...details } satisfies PendingPublish));
}

export function takePendingPublish(storage: Storage, projectId: string, now = Date.now()): { title: string; description: string } | undefined {
  const value = storage.getItem(STORAGE_KEY);
  if (!value) return undefined;
  storage.removeItem(STORAGE_KEY);
  try {
    const pending = JSON.parse(value) as Partial<PendingPublish>;
    if (pending.projectId !== projectId || typeof pending.createdAt !== "number" || now - pending.createdAt > MAX_AGE_MS || typeof pending.title !== "string" || typeof pending.description !== "string") return undefined;
    return { title: pending.title, description: pending.description };
  } catch {
    return undefined;
  }
}

export function forgetPendingPublish(storage: Storage): void {
  storage.removeItem(STORAGE_KEY);
}
