import type { CSSProperties, Ref } from "react";
import {
  cacheHitPercent,
  rangeStart,
  totalTokens,
  type HeatmapCell,
  type UsageRange,
  type UsageSummary,
} from "../shared/usage-stats.js";
import { BrandLogoArt } from "./brand-logo.js";
import { initials } from "./user-avatar.js";
import { language, t } from "./i18n.js";

export type UsageColor =
  "blue" | "green" | "orange" | "purple" | "pink" | "mono";
export type CardLook = "dark" | "light";
export type CardLayout = "landscape" | "portrait" | "strip";

export const USAGE_COLORS: readonly UsageColor[] = [
  "blue",
  "green",
  "orange",
  "purple",
  "pink",
  "mono",
];
export const CARD_LAYOUTS: readonly CardLayout[] = [
  "landscape",
  "portrait",
  "strip",
];

/**
 * Each colour on the page, where blue is the buttons' accent and mono the
 * text colour, and on the card, which needs plain values that read on its
 * dark and light backgrounds.
 */
const COLOR_VALUES: Record<
  UsageColor,
  { page: string; dark: string; light: string }
> = {
  blue: { page: "var(--color-accent)", dark: "#4C8DFF", light: "#2563EB" },
  green: { page: "#22A55B", dark: "#3FCF7A", light: "#1F9D55" },
  orange: { page: "#F07A1A", dark: "#FF9A3D", light: "#EA6C0C" },
  purple: { page: "#8B5CF6", dark: "#A68BFF", light: "#7C4DEB" },
  pink: { page: "#E5488A", dark: "#FF6FA8", light: "#DB2F77" },
  mono: { page: "var(--color-text)", dark: "#EDF1FC", light: "#11151D" },
};

const COLOR_KEY = "ohmygame:usage-color";

export function readUsageColor(): UsageColor {
  try {
    const stored = localStorage.getItem(COLOR_KEY);
    return USAGE_COLORS.includes(stored as UsageColor)
      ? (stored as UsageColor)
      : "blue";
  } catch {
    return "blue";
  }
}

export function saveUsageColor(color: UsageColor): void {
  try {
    localStorage.setItem(COLOR_KEY, color);
  } catch {
    // The choice only lasts for this visit.
  }
}

export function usageColorValue(color: UsageColor): string {
  return COLOR_VALUES[color].page;
}

/** Swatches for the heatmap's and bars' colour; the card follows the same choice. */
export function UsageColorPicker({
  value,
  onChange,
}: {
  value: UsageColor;
  onChange: (color: UsageColor) => void;
}) {
  return (
    <span
      className="usage-colors"
      role="radiogroup"
      aria-label={t("usage.color.label")}
    >
      {USAGE_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={t(`usage.color.${color}`)}
          title={t(`usage.color.${color}`)}
          className={`usage-color${value === color ? " is-current" : ""}`}
          style={
            { "--usage-swatch": COLOR_VALUES[color].page } as CSSProperties
          }
          onClick={() => onChange(color)}
        />
      ))}
    </span>
  );
}

const compact = new Intl.NumberFormat(language, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatTokens(value: number): string {
  return compact.format(value);
}

/**
 * "3 h 20 min", "45 min": how long turns took. `short` gives an hour or
 * more as hours, "2.5 h" or "67 h", for the card's narrow columns.
 */
export function formatDuration(ms: number, { short = false } = {}): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return t("usage.duration.underMinute");
  if (minutes < 60) return t("usage.duration.minutes", { count: minutes });
  if (short)
    return t("usage.duration.hours", {
      count: Number((minutes / 60).toFixed(minutes >= 600 ? 0 : 1)),
    });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest
    ? t("usage.duration.hoursMinutes", { hours, minutes: rest })
    : t("usage.duration.hours", { count: hours });
}

export function formatDay(
  date: string,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(language, options).format(
    new Date(year!, month! - 1, day!),
  );
}

// ---------- the card ----------

const CARD_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

const SIZES: Record<CardLayout, { width: number; height: number }> = {
  landscape: { width: 1200, height: 640 },
  portrait: { width: 1080, height: 1440 },
  strip: { width: 1200, height: 420 },
};

interface Palette {
  background: string;
  text: string;
  secondary: string;
  faint: string;
  track: string;
  accent: string;
  levels: string[];
}

function palette(look: CardLook, color: UsageColor): Palette {
  const base =
    look === "dark"
      ? {
          background: "#11151D",
          text: "#F5F7FB",
          secondary: "#A3AAB8",
          faint: "#6B7383",
          track: "#232A36",
          empty: "#1C222D",
        }
      : {
          background: "#FFFFFF",
          text: "#11151D",
          secondary: "#545B68",
          faint: "#9097A3",
          track: "#ECEEF2",
          empty: "#EFF1F4",
        };
  const accent = COLOR_VALUES[color][look];
  return {
    ...base,
    accent,
    levels: [
      base.empty,
      ...[0.3, 0.55, 0.8, 1].map((share) =>
        mix(accent, base.background, share),
      ),
    ],
  };
}

/** `color` over `background` at `share` opacity, as a plain hex value. */
function mix(color: string, background: string, share: number): string {
  const channels = (hex: string) =>
    [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  const top = channels(color);
  const bottom = channels(background);
  return `#${top
    .map((value, index) =>
      Math.round(value * share + bottom[index]! * (1 - share))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function cardSize(layout: CardLayout): {
  width: number;
  height: number;
} {
  return SIZES[layout];
}

/**
 * The shared image, drawn as SVG so the preview and the PNG are the same
 * drawing. Project names stay out of it; it shows models and totals only.
 */
export function UsageCard({
  ref,
  layout,
  look,
  color,
  summary,
  weeks,
  range,
  today,
  identity,
}: {
  ref?: Ref<SVGSVGElement>;
  layout: CardLayout;
  look: CardLook;
  color: UsageColor;
  summary: UsageSummary;
  weeks: HeatmapCell[][];
  range: UsageRange;
  today: string;
  /** Who shares it; without one the card leads with OhMyGame's mark. */
  identity?: CardIdentity;
}) {
  const { width, height } = SIZES[layout];
  const colors = palette(look, color);
  const tokens = totalTokens(summary.totals);
  const start = rangeStart(range, today);
  const period = start
    ? `${formatDay(start)} – ${formatDay(today)}`
    : t("usage.card.until", {
        date: formatDay(today, { dateStyle: "medium" }),
      });
  const card = {
    colors,
    summary,
    weeks,
    tokens,
    range,
    period,
    width,
    height,
    identity,
  };
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fontFamily={CARD_FONT}
      role="img"
      aria-label={`${t("usage.title")}: ${formatTokens(tokens)}`}
    >
      <rect width={width} height={height} rx="40" fill={colors.background} />
      {look === "light" ? (
        <rect
          x="0.5"
          y="0.5"
          width={width - 1}
          height={height - 1}
          rx="40"
          fill="none"
          stroke={colors.track}
        />
      ) : null}
      {layout === "landscape" ? (
        <Landscape {...card} />
      ) : layout === "portrait" ? (
        <Portrait {...card} />
      ) : (
        <Strip {...card} />
      )}
    </svg>
  );
}

/** The person on the card; `avatar` is a data URL, as an exported SVG can't load others. */
export interface CardIdentity {
  name: string;
  avatar?: string;
}

interface CardParts {
  identity?: CardIdentity;
  colors: Palette;
  summary: UsageSummary;
  weeks: HeatmapCell[][];
  tokens: number;
  range: UsageRange;
  period: string;
  width: number;
  height: number;
}

function Landscape({
  colors,
  summary,
  weeks,
  tokens,
  range,
  period,
  width,
  height,
  identity,
}: CardParts) {
  return (
    <>
      <Header colors={colors} identity={identity} x={64} y={52} size={56} />
      <Period
        colors={colors}
        range={range}
        period={period}
        x={width - 64}
        y={84}
      />
      <text x="64" y="176" fontSize="22" fill={colors.faint}>
        {t("usage.card.heading")}
      </text>
      <text
        x="60"
        y="262"
        fontSize="88"
        fontWeight="700"
        letterSpacing="-2"
        fill={colors.text}
      >
        {formatTokens(tokens)}
      </text>
      <Facts
        colors={colors}
        summary={summary}
        x={64}
        y={316}
        columns={4}
        columnWidth={152}
        rowHeight={0}
        size={28}
      />
      <Models
        colors={colors}
        summary={summary}
        tokens={tokens}
        x={700}
        y={176}
        width={width - 764}
        count={4}
      />
      <Heatmap
        colors={colors}
        weeks={weeks}
        summary={summary}
        x={64}
        y={436}
        width={width - 128}
      />
      <Footer
        colors={colors}
        identity={identity}
        x={64}
        y={height - 36}
        width={width - 128}
      />
    </>
  );
}

function Portrait({
  colors,
  summary,
  weeks,
  tokens,
  range,
  period,
  width,
  height,
  identity,
}: CardParts) {
  return (
    <>
      <Header colors={colors} identity={identity} x={72} y={72} size={72} />
      <Period
        colors={colors}
        range={range}
        period={period}
        x={width - 72}
        y={112}
      />
      <text x="72" y="290" fontSize="30" fill={colors.faint}>
        {t("usage.card.heading")}
      </text>
      <text
        x="66"
        y="420"
        fontSize="150"
        fontWeight="700"
        letterSpacing="-4"
        fill={colors.text}
      >
        {formatTokens(tokens)}
      </text>
      <Facts
        colors={colors}
        summary={summary}
        x={72}
        y={510}
        columns={2}
        columnWidth={468}
        rowHeight={120}
        size={46}
      />
      <Models
        colors={colors}
        summary={summary}
        tokens={tokens}
        x={72}
        y={800}
        width={width - 144}
        count={4}
        rowHeight={64}
        size={26}
      />
      <Heatmap
        colors={colors}
        weeks={weeks}
        summary={summary}
        x={72}
        y={1166}
        width={width - 144}
      />
      <Footer
        colors={colors}
        identity={identity}
        x={72}
        y={height - 56}
        width={width - 144}
      />
    </>
  );
}

function Strip({
  colors,
  summary,
  weeks,
  tokens,
  range,
  period,
  width,
  height,
  identity,
}: CardParts) {
  return (
    <>
      <Header colors={colors} identity={identity} x={64} y={48} size={56} />
      <text
        x={width - 64}
        y="86"
        fontSize="44"
        fontWeight="700"
        textAnchor="end"
        fill={colors.text}
      >
        {formatTokens(tokens)}
        <tspan
          fontSize="20"
          fontWeight="400"
          fill={colors.secondary}
        >{` ${t("usage.card.tokens")}`}</tspan>
      </text>
      <text
        x={width - 64}
        y="116"
        fontSize="17"
        textAnchor="end"
        fill={colors.faint}
      >{`${t(`usage.card.range.${range}`)} · ${period}`}</text>
      <Heatmap
        colors={colors}
        weeks={weeks}
        summary={summary}
        x={64}
        y={192}
        width={width - 128}
      />
      <Footer
        colors={colors}
        identity={identity}
        x={64}
        y={height - 30}
        width={width - 128}
      />
    </>
  );
}

/**
 * The card's lead: the person's avatar and name, or, when they share
 * without them, OhMyGame's mark kept as small as the person's would be.
 */
function Header({
  colors,
  identity,
  x,
  y,
  size,
}: {
  colors: Palette;
  identity?: CardIdentity;
  x: number;
  y: number;
  size: number;
}) {
  if (!identity) {
    const mark = Math.round(size * 0.78);
    const top = y + (size - mark) / 2;
    return (
      <>
        <Logo x={x} y={top} size={mark} />
        <text
          x={x + mark + 12}
          y={top + mark * 0.72}
          fontSize={mark * 0.56}
          fontWeight="650"
          fill={colors.text}
        >
          OhMyGame
        </text>
      </>
    );
  }
  const radius = size / 2;
  return (
    <>
      <defs>
        <clipPath id="usage-card-avatar">
          <circle cx={x + radius} cy={y + radius} r={radius} />
        </clipPath>
      </defs>
      {identity.avatar ? (
        <image
          href={identity.avatar}
          x={x}
          y={y}
          width={size}
          height={size}
          preserveAspectRatio="xMidYMid slice"
          clipPath="url(#usage-card-avatar)"
        />
      ) : (
        <>
          <circle
            cx={x + radius}
            cy={y + radius}
            r={radius}
            fill={mix(colors.accent, colors.background, 0.2)}
          />
          <text
            x={x + radius}
            y={y + radius + size * 0.13}
            fontSize={size * 0.38}
            fontWeight="650"
            textAnchor="middle"
            fill={colors.accent}
          >
            {initials(identity.name)}
          </text>
        </>
      )}
      <circle
        cx={x + radius}
        cy={y + radius}
        r={radius - 0.5}
        fill="none"
        stroke={colors.text}
        strokeOpacity="0.12"
      />
      <text
        x={x + size + 16}
        y={y + size * 0.46}
        fontSize={size * 0.44}
        fontWeight="650"
        fill={colors.text}
      >
        {truncate(identity.name, 24)}
      </text>
      <text
        x={x + size + 16}
        y={y + size * 0.88}
        fontSize={size * 0.3}
        fill={colors.faint}
      >
        {t("usage.card.subtitle")}
      </text>
    </>
  );
}

function Logo({ x, y, size }: { x: number; y: number; size: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${size / 280})`}>
      <BrandLogoArt gradient="usage-card-logo" />
    </g>
  );
}

function Period({
  colors,
  range,
  period,
  x,
  y,
}: {
  colors: Palette;
  range: UsageRange;
  period: string;
  x: number;
  y: number;
}) {
  return (
    <>
      <text x={x} y={y} fontSize="20" textAnchor="end" fill={colors.secondary}>
        {t(`usage.card.range.${range}`)}
      </text>
      <text x={x} y={y + 26} fontSize="18" textAnchor="end" fill={colors.faint}>
        {period}
      </text>
    </>
  );
}

function Facts({
  colors,
  summary,
  x,
  y,
  columns,
  columnWidth,
  rowHeight,
  size,
}: {
  colors: Palette;
  summary: UsageSummary;
  x: number;
  y: number;
  columns: number;
  columnWidth: number;
  rowHeight: number;
  size: number;
}) {
  const { totals } = summary;
  const hit = cacheHitPercent(totals);
  const facts = [
    {
      label: t("usage.input"),
      value: formatTokens(totals.input + totals.cacheRead + totals.cacheWrite),
    },
    { label: t("usage.output"), value: formatTokens(totals.output) },
    totals.durationMs > 0
      ? {
          label: t("usage.time"),
          value: formatDuration(totals.durationMs, { short: true }),
        }
      : {
          label: t("usage.card.cacheHit"),
          value: hit !== undefined ? `${hit}%` : "—",
        },
    {
      label: t("usage.card.longestStreak"),
      value: t("usage.card.days", { count: summary.longestStreak }),
    },
  ];
  return (
    <>
      {facts.map((fact, index) => (
        <g
          key={fact.label}
          transform={`translate(${x + (index % columns) * columnWidth} ${y + Math.floor(index / columns) * rowHeight})`}
        >
          <text fontSize={size * 0.6} fill={colors.faint}>
            {fact.label}
          </text>
          <text
            y={size * 1.36}
            fontSize={size}
            fontWeight="600"
            fill={colors.text}
          >
            {fact.value}
          </text>
        </g>
      ))}
    </>
  );
}

function Models({
  colors,
  summary,
  tokens,
  x,
  y,
  width,
  count,
  rowHeight = 48,
  size = 20,
}: {
  colors: Palette;
  summary: UsageSummary;
  tokens: number;
  x: number;
  y: number;
  width: number;
  count: number;
  rowHeight?: number;
  size?: number;
}) {
  const models = summary.models.slice(0, count);
  // The same model through two providers is told apart by the provider.
  const repeated = new Set(
    models
      .map((model) => model.label)
      .filter((label, index, labels) => labels.indexOf(label) !== index),
  );
  const characters = Math.floor(width / (size * 0.62)) - 10;
  return (
    <>
      <text x={x} y={y} fontSize={size * 1.1} fill={colors.faint}>
        {t("usage.card.topModels")}
      </text>
      {models.map((model, index) => {
        const share = tokens > 0 ? totalTokens(model) / tokens : 0;
        const rowY = y + 38 + index * rowHeight + (size - 20);
        const label = repeated.has(model.label)
          ? truncate(model.label, Math.max(12, characters - 14))
          : truncate(model.label, characters);
        return (
          <g key={model.key}>
            <text
              x={x}
              y={rowY}
              fontSize={size}
              fontWeight="550"
              fill={colors.text}
            >
              {label}
              {repeated.has(model.label) ? (
                <tspan
                  fontWeight="400"
                  fill={colors.faint}
                >{` · ${truncate(model.providerName ?? t("usage.customProvider"), 14)}`}</tspan>
              ) : null}
            </text>
            <text
              x={x + width}
              y={rowY}
              fontSize={size * 0.9}
              textAnchor="end"
              fill={colors.secondary}
            >
              {`${formatTokens(totalTokens(model))} · ${Math.max(1, Math.round(share * 100))}%`}
            </text>
            <rect
              x={x}
              y={rowY + 12}
              width={width}
              height="6"
              rx="3"
              fill={colors.track}
            />
            <rect
              x={x}
              y={rowY + 12}
              width={Math.max(6, width * share)}
              height="6"
              rx="3"
              fill={colors.accent}
            />
          </g>
        );
      })}
    </>
  );
}

function Heatmap({
  colors,
  weeks,
  summary,
  x,
  y,
  width,
}: {
  colors: Palette;
  weeks: HeatmapCell[][];
  summary: UsageSummary;
  x: number;
  y: number;
  width: number;
}) {
  const pitch = width / weeks.length;
  const cell = pitch - Math.max(3, pitch * 0.2);
  return (
    <>
      <text x={x} y={y - 16} fontSize="17" fill={colors.faint}>
        {t("usage.pastYear")}
      </text>
      <text
        x={x + width}
        y={y - 16}
        fontSize="17"
        textAnchor="end"
        fill={colors.faint}
      >
        {t("usage.card.activeDays", { count: summary.activeDays })}
      </text>
      {weeks.map((week, column) =>
        week.map((day, row) =>
          day.future ? null : (
            <rect
              key={day.date}
              x={x + column * pitch}
              y={y + row * pitch}
              width={cell}
              height={cell}
              rx={cell / 5}
              fill={colors.levels[day.level]}
            />
          ),
        ),
      )}
    </>
  );
}

function Footer({
  colors,
  identity,
  x,
  y,
  width,
}: {
  colors: Palette;
  identity?: CardIdentity;
  x: number;
  y: number;
  width: number;
}) {
  const right = x + width;
  return (
    <>
      {identity ? (
        <>
          <Logo x={x} y={y - 17} size={22} />
          <text x={x + 30} y={y} fontSize="17" fill={colors.faint}>
            <tspan fontWeight="650" fill={colors.secondary}>
              OhMyGame
            </tspan>
            {" · ohmygame.ai"}
          </text>
        </>
      ) : (
        <text x={x} y={y} fontSize="17" fill={colors.faint}>
          ohmygame.ai
        </text>
      )}
      <text
        x={right - 136}
        y={y}
        fontSize="15"
        textAnchor="end"
        fill={colors.faint}
      >
        {t("usage.less")}
      </text>
      {colors.levels.map((fill, index) => (
        <rect
          key={index}
          x={right - 128 + index * 18}
          y={y - 13}
          width="14"
          height="14"
          rx="3"
          fill={fill}
        />
      ))}
      <text x={right} y={y} fontSize="15" textAnchor="end" fill={colors.faint}>
        {t("usage.more")}
      </text>
    </>
  );
}

function truncate(value: string, length: number): string {
  const characters = [...value];
  return characters.length <= length
    ? value
    : `${characters.slice(0, length - 1).join("")}…`;
}

/** Draws an SVG element into a PNG at `scale` times its size; the browser does it, no library. */
export async function svgToPng(
  svg: SVGSVGElement,
  scale: number,
): Promise<Blob> {
  const width = Number(svg.getAttribute("width"));
  const height = Number(svg.getAttribute("height"));
  const markup = new XMLSerializer().serializeToString(svg);
  const image = new Image();
  image.decoding = "async";
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  context.scale(scale, scale);
  context.drawImage(image, 0, 0, width, height);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Could not encode the image")),
      "image/png",
    ),
  );
}
