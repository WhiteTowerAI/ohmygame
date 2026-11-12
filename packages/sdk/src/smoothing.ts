/**
 * Drawing other players between the updates a room sends. Positions arrive a few times a
 * second (once a tick, or once a tick for an owner room's player states); drawing each one
 * as it arrives makes others jump. A Smoother keeps the recent updates of each thing, keyed
 * by any string such as a playerId, and gives the value to draw at the current time.
 *
 * - "interpolate" (the default) draws `delayMs` in the past, between the two updates around
 *   that time, so motion follows exactly the path the updates describe. It runs dry when an
 *   update is late, and then carries on along the last movement for at most `maxExtrapolateMs`.
 * - "extrapolate" draws ahead of the newest update along its movement, at most
 *   `maxExtrapolateMs`, easing toward that point. Shows others sooner, but overshoots a
 *   player who stops or turns, and eases back.
 * - "damped" eases toward the newest update. Never overshoots; trails moving things by
 *   about `smoothMs`.
 *
 * Only numeric fields are smoothed; give the fields to smooth in each update, such as
 * { x, y }. Smoothing runs on the page only and costs the service nothing.
 */

export type SmoothingMode = "interpolate" | "extrapolate" | "damped";

export interface SmoothingOptions {
  /** How to draw between updates. Default "interpolate". */
  mode?: SmoothingMode;
  /**
   * The time between updates in milliseconds, such as the room's tick: client.tickMs.
   * The defaults below derive from it. Default 50.
   */
  intervalMs?: number;
  /** "interpolate": how far in the past to draw. Default intervalMs: one update behind. */
  delayMs?: number;
  /** "extrapolate" and "damped": the easing time constant in milliseconds. Default 50. */
  smoothMs?: number;
  /** The furthest to carry movement past the newest update. Default intervalMs. */
  maxExtrapolateMs?: number;
  /**
   * A jump larger than this, in the fields' own units, is a teleport, such as a respawn: it
   * is drawn at once instead of glided across. Default Infinity (never).
   */
  snapDistance?: number;
  /** Fields that are angles in radians, eased the short way round. */
  angles?: readonly string[];
}

type Values = Record<string, number>;
interface Sample {
  at: number;
  values: Values;
}
interface Track {
  samples: Sample[];
  shown?: Values;
  shownAt?: number;
}

/** The most updates kept per key: interpolation needs the two around its time. */
const SAMPLES_KEPT = 8;

const now = () => (typeof performance === "undefined" ? Date.now() : performance.now());

export class Smoother {
  private readonly tracks = new Map<string, Track>();
  private readonly mode: SmoothingMode;
  private readonly delayMs: number;
  private readonly smoothMs: number;
  private readonly maxExtrapolateMs: number;
  private readonly snapDistance: number;
  private readonly angles: ReadonlySet<string>;

  constructor(options: SmoothingOptions = {}) {
    const interval = positive(options.intervalMs, 50);
    this.mode = options.mode ?? "interpolate";
    this.delayMs = nonNegative(options.delayMs, interval);
    this.smoothMs = nonNegative(options.smoothMs, 50);
    this.maxExtrapolateMs = nonNegative(options.maxExtrapolateMs, interval);
    this.snapDistance = options.snapDistance ?? Infinity;
    this.angles = new Set(options.angles ?? []);
  }

  /**
   * Records an update for `key`, such as { x, y } from a snapshot, received at `at`
   * (performance.now() by default). An update equal to the last one is still recorded, so a
   * player who stopped is drawn stopped.
   */
  push(key: string, values: Readonly<Values>, at: number = now()): void {
    const fields: Values = {};
    for (const [field, value] of Object.entries(values)) if (Number.isFinite(value)) fields[field] = value;
    let track = this.tracks.get(key);
    if (!track) this.tracks.set(key, (track = { samples: [] }));
    const last = track.samples.at(-1);
    if (last) {
      if (at < last.at) at = last.at;
      for (const field of this.angles)
        if (field in fields && field in last.values) fields[field] = last.values[field]! + shortArc(fields[field]! - last.values[field]!);
      if (distance(last.values, fields, this.angles) > this.snapDistance) {
        track.samples = [];
        track.shown = undefined;
      }
    }
    track.samples.push({ at, values: fields });
    if (track.samples.length > SAMPLES_KEPT) track.samples.shift();
  }

  /** The values to draw for `key` at `time` (performance.now() by default), or undefined before its first update. */
  get(key: string, time: number = now()): Values | undefined {
    const track = this.tracks.get(key);
    const last = track?.samples.at(-1);
    if (!track || !last) return undefined;
    let values: Values;
    if (this.mode === "interpolate") values = this.interpolate(track.samples, time - this.delayMs);
    else {
      const target = this.mode === "extrapolate" ? this.ahead(track.samples, time) : last.values;
      values = this.ease(track, target, time);
    }
    for (const field of this.angles) if (field in values) values[field] = wrapAngle(values[field]!);
    return values;
  }

  /** Forgets `key`, such as a player who left. */
  delete(key: string): void {
    this.tracks.delete(key);
  }

  /** Forgets every key not in `keys`, such as the players no longer in the snapshot. */
  retain(keys: Iterable<string>): void {
    const kept = new Set(keys);
    for (const key of this.tracks.keys()) if (!kept.has(key)) this.tracks.delete(key);
  }

  private interpolate(samples: Sample[], time: number): Values {
    const first = samples[0]!;
    if (time <= first.at) return { ...first.values };
    for (let index = samples.length - 1; index > 0; index--) {
      const before = samples[index - 1]!;
      const after = samples[index]!;
      if (time >= before.at && time <= after.at) {
        const span = after.at - before.at;
        return mix(before.values, after.values, span > 0 ? (time - before.at) / span : 1);
      }
    }
    // Past the newest update: an update is late, so carry on along the last movement.
    return this.ahead(samples, time);
  }

  /** The newest update moved along its last movement to `time`, at most maxExtrapolateMs past it. */
  private ahead(samples: Sample[], time: number): Values {
    const last = samples.at(-1)!;
    const before = samples.at(-2);
    if (!before || last.at <= before.at) return { ...last.values };
    const reach = Math.min(Math.max(time - last.at, 0), this.maxExtrapolateMs) / (last.at - before.at);
    return mix(before.values, last.values, 1 + reach);
  }

  private ease(track: Track, target: Values, time: number): Values {
    const shown = track.shown;
    if (!shown || track.shownAt === undefined || this.smoothMs === 0) {
      track.shown = { ...target };
      track.shownAt = time;
      return { ...target };
    }
    const k = 1 - Math.exp(-Math.max(time - track.shownAt, 0) / this.smoothMs);
    track.shownAt = time;
    for (const [field, value] of Object.entries(target)) shown[field] = field in shown ? shown[field]! + (value - shown[field]!) * k : value;
    return { ...shown };
  }
}

function mix(from: Values, to: Values, t: number): Values {
  const result: Values = { ...to };
  for (const [field, value] of Object.entries(to)) if (field in from) result[field] = from[field]! + (value - from[field]!) * t;
  return result;
}

function distance(from: Values, to: Values, angles: ReadonlySet<string>): number {
  let sum = 0;
  for (const [field, value] of Object.entries(to)) if (field in from && !angles.has(field)) sum += (value - from[field]!) ** 2;
  return Math.sqrt(sum);
}

function shortArc(delta: number): number {
  return delta - 2 * Math.PI * Math.round(delta / (2 * Math.PI));
}

function wrapAngle(angle: number): number {
  return shortArc(angle);
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}
