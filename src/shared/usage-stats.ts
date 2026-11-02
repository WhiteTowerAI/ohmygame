/**
 * What agents used in conversations: tokens from the usage OhMyGame's agent
 * recorded with each response and coding agents recorded for each request
 * or turn, and the time turns took.
 */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Turns: a message and the agent's work on it. */
  turns: number;
  /** Time the turns took, leaving out long waits such as for an approval. */
  durationMs: number;
}

/** One day's use of one model in one project. */
export interface UsageRow extends UsageTotals {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  projectId: string;
  provider: string;
  model: string;
}

export interface UsageStats {
  rows: UsageRow[];
  /** Names of the projects the rows refer to. */
  projects: Array<{ id: string; name: string }>;
  /** Names of the providers set up now; a removed one keeps its ID. */
  providers?: Array<{ id: string; name: string }>;
}

export type UsageRange = "7d" | "30d" | "all";

export interface UsageGroup extends UsageTotals {
  key: string;
  label: string;
  provider?: string;
  /** Unset for a custom provider that was removed: its ID means nothing to people. */
  providerName?: string;
}

export interface UsageSummary {
  totals: UsageTotals;
  models: UsageGroup[];
  projects: UsageGroup[];
  /** Days in the range with tokens or turns recorded. */
  activeDays: number;
  /** Consecutive days with use up to today, or yesterday when today has none yet. */
  currentStreak: number;
  longestStreak: number;
}

export function emptyTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    turns: 0,
    durationMs: 0,
  };
}

export function addTotals(
  target: UsageTotals,
  value: UsageTotals,
): UsageTotals {
  target.input += value.input;
  target.output += value.output;
  target.cacheRead += value.cacheRead;
  target.cacheWrite += value.cacheWrite;
  target.turns += value.turns;
  target.durationMs += value.durationMs;
  return target;
}

export function totalTokens(value: UsageTotals): number {
  return value.input + value.output + value.cacheRead + value.cacheWrite;
}

/** Prompt tokens read from the provider's cache, as a share of all prompt tokens. */
export function cacheHitPercent(value: UsageTotals): number | undefined {
  const prompt = value.input + value.cacheRead + value.cacheWrite;
  return prompt > 0 ? Math.round((value.cacheRead / prompt) * 100) : undefined;
}

/** `YYYY-MM-DD` of a time in the local time zone. */
export function localDate(time: Date | number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The calendar day `days` after `date` (before, when negative). */
export function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return localDate(new Date(year!, month! - 1, day! + days));
}

/** The first day a range covers, or undefined for all of it. */
export function rangeStart(
  range: UsageRange,
  today: string,
): string | undefined {
  if (range === "7d") return shiftDate(today, -6);
  if (range === "30d") return shiftDate(today, -29);
  return undefined;
}

/** Tokens of each day, across projects and models. */
export function dailyTokens(stats: UsageStats): Map<string, number> {
  const days = new Map<string, number>();
  for (const row of stats.rows)
    days.set(row.date, (days.get(row.date) ?? 0) + totalTokens(row));
  return days;
}

export function summarizeUsage(
  stats: UsageStats,
  range: UsageRange,
  today: string,
): UsageSummary {
  const start = rangeStart(range, today);
  const totals = emptyTotals();
  const models = new Map<string, UsageGroup>();
  const projects = new Map<string, UsageGroup>();
  const names = new Map(
    stats.projects.map((project) => [project.id, project.name]),
  );
  const providerNames = new Map(
    (stats.providers ?? []).map((provider) => [provider.id, provider.name]),
  );
  const activeInRange = new Set<string>();
  for (const row of stats.rows) {
    if ((start && row.date < start) || row.date > today) continue;
    addTotals(totals, row);
    activeInRange.add(row.date);
    const modelKey = `${row.provider}/${row.model}`;
    addTotals(
      models.get(modelKey) ??
        set(models, modelKey, {
          key: modelKey,
          label: row.model,
          provider: row.provider,
          ...providerName(row.provider, providerNames),
          ...emptyTotals(),
        }),
      row,
    );
    addTotals(
      projects.get(row.projectId) ??
        set(projects, row.projectId, {
          key: row.projectId,
          label: names.get(row.projectId) ?? row.projectId,
          ...emptyTotals(),
        }),
      row,
    );
  }
  const byTokens = (a: UsageGroup, b: UsageGroup) =>
    totalTokens(b) - totalTokens(a);
  return {
    totals,
    models: [...models.values()]
      .filter((group) => totalTokens(group) > 0)
      .sort(byTokens),
    projects: [...projects.values()]
      .filter((group) => totalTokens(group) > 0)
      .sort(byTokens),
    activeDays: activeInRange.size,
    ...streaks(new Set(stats.rows.map((row) => row.date)), today),
  };
}

function streaks(
  active: Set<string>,
  today: string,
): { currentStreak: number; longestStreak: number } {
  let longestStreak = 0;
  for (const date of active) {
    if (active.has(shiftDate(date, -1))) continue;
    let length = 1;
    while (active.has(shiftDate(date, length))) length += 1;
    longestStreak = Math.max(longestStreak, length);
  }
  let day = active.has(today) ? today : shiftDate(today, -1);
  let currentStreak = 0;
  while (active.has(day)) {
    currentStreak += 1;
    day = shiftDate(day, -1);
  }
  return { currentStreak, longestStreak };
}

export interface HeatmapCell {
  date: string;
  tokens: number;
  /** 0 for no use, then 1–4 by its rank among the busy days. */
  level: 0 | 1 | 2 | 3 | 4;
  /** After today: drawn empty so the last week keeps its shape. */
  future: boolean;
}

/**
 * Weeks of days, oldest first, each from Sunday to Saturday, with the last
 * week holding today. Levels rank a day among the other busy days shown;
 * the busiest is always 4.
 */
export function usageHeatmap(
  days: ReadonlyMap<string, number>,
  today: string,
  weeks = 53,
): HeatmapCell[][] {
  const [year, month, day] = today.split("-").map(Number);
  const weekday = new Date(year!, month! - 1, day!).getDay();
  const first = shiftDate(today, -(weeks - 1) * 7 - weekday);
  const busy: number[] = [];
  for (let index = 0; index < weeks * 7; index++) {
    const date = shiftDate(first, index);
    const tokens = date <= today ? (days.get(date) ?? 0) : 0;
    if (tokens > 0) busy.push(tokens);
  }
  busy.sort((a, b) => a - b);
  // A day's rank among the busy days, so one huge day doesn't flatten the rest.
  const level = (tokens: number): HeatmapCell["level"] => {
    if (tokens <= 0) return 0;
    if (busy.length < 2) return 4;
    let rank = busy.length - 1;
    while (rank > 0 && busy[rank]! > tokens) rank -= 1;
    return Math.min(
      4,
      1 + Math.floor((rank / (busy.length - 1)) * 4),
    ) as HeatmapCell["level"];
  };
  return Array.from({ length: weeks }, (_, week) =>
    Array.from({ length: 7 }, (_, weekdayIndex) => {
      const date = shiftDate(first, week * 7 + weekdayIndex);
      const future = date > today;
      const tokens = future ? 0 : (days.get(date) ?? 0);
      return { date, tokens, level: level(tokens), future };
    }),
  );
}

/** Coding agents record their runtime as the provider; their names are product names. */
const RUNTIME_NAMES: Readonly<Record<string, string>> = {
  "claude-code-cli": "Claude Code",
  "codex-cli": "Codex",
  "opencode-cli": "OpenCode",
};

function providerName(
  id: string,
  names: ReadonlyMap<string, string>,
): { providerName?: string } {
  const name = names.get(id) ?? RUNTIME_NAMES[id];
  if (name) return { providerName: name };
  // A custom provider's ID is generated; once it's gone there is no name to show.
  return id.startsWith("custom-") ? {} : { providerName: id };
}

function set<K, V>(map: Map<K, V>, key: K, value: V): V {
  map.set(key, value);
  return value;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
