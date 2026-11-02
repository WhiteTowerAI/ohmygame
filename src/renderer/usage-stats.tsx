import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  cacheHitPercent,
  dailyTokens,
  localDate,
  rangeStart,
  summarizeUsage,
  totalTokens,
  usageHeatmap,
  type HeatmapCell,
  type UsageGroup,
  type UsageRange,
  type UsageStats,
  type UsageSummary,
} from "../shared/usage-stats.js";
import { getUsageStats } from "./api.js";
import { language, t } from "./i18n.js";
import { Copy, Download, Share2 } from "./icons.js";
import { downloadAssetBlob } from "./library-assets.js";
import { ProviderMark } from "./model-selector.js";
import { SettingsGroup } from "./settings-parts.js";
import { useAuth } from "./auth.js";
import {
  Button,
  Checkbox,
  Dialog,
  SegmentedControl,
  Spinner,
  Stat,
  useToast,
} from "./ui/index.js";
import {
  CARD_LAYOUTS,
  formatDay,
  formatDuration,
  formatTokens,
  readUsageColor,
  saveUsageColor,
  svgToPng,
  UsageCard,
  UsageColorPicker,
  usageColorValue,
  type CardLayout,
  type CardLook,
  type UsageColor,
} from "./usage-card.js";

const RANGES: readonly UsageRange[] = ["7d", "30d", "all"];
const whole = new Intl.NumberFormat(language);

/** Token use under Settings → Account, shown whether or not someone is signed in. */
export function AccountUsage() {
  const [stats, setStats] = useState<UsageStats>();
  const [error, setError] = useState<string>();
  const [range, setRange] = useState<UsageRange>("30d");
  const [color, setColor] = useState<UsageColor>(readUsageColor);
  const [sharing, setSharing] = useState(false);
  const today = localDate(Date.now());

  useEffect(() => {
    let live = true;
    getUsageStats().then(
      (value) => live && setStats(value),
      (cause: unknown) =>
        live &&
        setError(cause instanceof Error ? cause.message : String(cause)),
    );
    return () => {
      live = false;
    };
  }, []);

  const summary = useMemo(
    () => (stats ? summarizeUsage(stats, range, today) : undefined),
    [stats, range, today],
  );
  const heatmap = useMemo(
    () => (stats ? usageHeatmap(dailyTokens(stats), today) : undefined),
    [stats, today],
  );
  const hasUsage = Boolean(
    summary && (totalTokens(summary.totals) > 0 || summary.totals.turns > 0),
  );
  const hasAnyUsage = Boolean(stats?.rows.length);
  const chooseColor = (next: UsageColor) => {
    setColor(next);
    saveUsageColor(next);
  };

  return (
    <div
      className="usage"
      style={{ "--usage-color": usageColorValue(color) } as CSSProperties}
    >
      <SettingsGroup
        title={t("usage.title")}
        description={t("usage.description")}
        actions={
          <>
            <SegmentedControl
              size="sm"
              label={t("usage.range.label")}
              value={range}
              options={RANGES.map((value) => ({
                value,
                label: t(`usage.range.${value}`),
              }))}
              onChange={setRange}
            />
            <Button
              size="sm"
              icon={<Share2 size={14} />}
              disabled={!hasAnyUsage}
              onClick={() => setSharing(true)}
            >
              {t("usage.share.open")}
            </Button>
          </>
        }
      >
        {error ? (
          <div className="usage-empty">
            {t("usage.error", { message: error })}
          </div>
        ) : !summary || !heatmap ? (
          <div className="usage-empty" role="status">
            <Spinner size={14} /> {t("usage.loading")}
          </div>
        ) : (
          <>
            {hasUsage ? (
              <UsageTotalsRow summary={summary} />
            ) : (
              <div className="usage-empty">
                {t(hasAnyUsage ? "usage.emptyRange" : "usage.empty")}
              </div>
            )}
            <UsageHeatmap
              weeks={heatmap}
              summary={summary}
              range={range}
              today={today}
            />
          </>
        )}
      </SettingsGroup>
      {summary && hasUsage ? (
        <>
          <UsageBreakdown
            title={t("usage.byModel")}
            groups={summary.models}
            total={totalTokens(summary.totals)}
            showProvider
          />
          <UsageBreakdown
            title={t("usage.byProject")}
            groups={summary.projects.slice(0, 8)}
            total={totalTokens(summary.totals)}
          />
        </>
      ) : null}
      {summary && heatmap ? (
        <UsageShareDialog
          open={sharing}
          onClose={() => setSharing(false)}
          summary={summary}
          weeks={heatmap}
          range={range}
          today={today}
          color={color}
          onColor={chooseColor}
        />
      ) : null}
    </div>
  );
}

function UsageTotalsRow({ summary }: { summary: UsageSummary }) {
  const { totals } = summary;
  const hit = cacheHitPercent(totals);
  return (
    <div className="usage-totals">
      <Stat
        label={t("usage.total")}
        value={formatTokens(totalTokens(totals))}
        note={
          totals.turns > 0
            ? t("usage.turns", { count: totals.turns })
            : undefined
        }
      />
      <Stat
        label={t("usage.input")}
        value={formatTokens(
          totals.input + totals.cacheRead + totals.cacheWrite,
        )}
        note={
          hit !== undefined ? t("usage.cacheHit", { percent: hit }) : undefined
        }
      />
      <Stat label={t("usage.output")} value={formatTokens(totals.output)} />
      <Stat
        label={t("usage.time")}
        value={totals.durationMs > 0 ? formatDuration(totals.durationMs) : "—"}
        note={
          totals.turns > 0 && totals.durationMs > 0
            ? t("usage.perTurn", {
                duration: formatDuration(totals.durationMs / totals.turns),
              })
            : undefined
        }
      />
    </div>
  );
}

function UsageHeatmap({
  weeks,
  summary,
  range,
  today,
}: {
  weeks: HeatmapCell[][];
  summary: UsageSummary;
  range: UsageRange;
  today: string;
}) {
  const start = rangeStart(range, today);
  return (
    <div className="usage-heatmap-section">
      <div className="usage-heatmap-head">
        <span>{t("usage.pastYear")}</span>
        <span className="usage-heatmap-facts">
          <span>
            {t("usage.currentStreak", { count: summary.currentStreak })}
          </span>
          <span>
            {t("usage.longestStreak", { count: summary.longestStreak })}
          </span>
        </span>
      </div>
      <div
        className="usage-heatmap"
        role="img"
        aria-label={t("usage.heatmapLabel", { count: summary.activeDays })}
      >
        {weeks.map((week) => (
          <div className="usage-heatmap-week" key={week[0]!.date}>
            {week.map((cell) => (
              <span
                key={cell.date}
                className={`usage-heatmap-cell is-level-${cell.level}${cell.future ? " is-future" : ""}${start && cell.date >= start && !cell.future ? " is-in-range" : ""}`}
                title={
                  cell.future
                    ? undefined
                    : cell.tokens > 0
                      ? t("usage.dayTokens", {
                          date: formatDay(cell.date, { dateStyle: "medium" }),
                          tokens: whole.format(cell.tokens),
                        })
                      : t("usage.dayNone", {
                          date: formatDay(cell.date, { dateStyle: "medium" }),
                        })
                }
              />
            ))}
          </div>
        ))}
      </div>
      <div className="usage-heatmap-legend" aria-hidden="true">
        <span>{t("usage.less")}</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span
            key={level}
            className={`usage-heatmap-cell is-level-${level}`}
          />
        ))}
        <span>{t("usage.more")}</span>
      </div>
    </div>
  );
}

function UsageBreakdown({
  title,
  groups,
  total,
  showProvider = false,
}: {
  title: string;
  groups: UsageGroup[];
  total: number;
  showProvider?: boolean;
}) {
  if (!groups.length) return null;
  return (
    <SettingsGroup title={title}>
      {groups.map((group) => {
        const tokens = totalTokens(group);
        const share = total > 0 ? (tokens / total) * 100 : 0;
        return (
          <div className="usage-row" key={group.key}>
            <div className="usage-row-name">
              {showProvider ? (
                <ProviderMark
                  provider={group.provider}
                  name={group.providerName ?? t("usage.customProvider")}
                  size={16}
                />
              ) : null}
              <strong title={group.label}>{group.label}</strong>
              {showProvider ? (
                <span>{group.providerName ?? t("usage.customProvider")}</span>
              ) : null}
            </div>
            <span className="usage-row-meter" aria-hidden="true">
              <span style={{ width: `${Math.max(share, 1)}%` }} />
            </span>
            <span className="usage-row-tokens" title={whole.format(tokens)}>
              {formatTokens(tokens)}
            </span>
            <span className="usage-row-share">
              {share < 1 ? "<1%" : `${Math.round(share)}%`}
            </span>
          </div>
        );
      })}
    </SettingsGroup>
  );
}

function UsageShareDialog({
  open,
  onClose,
  summary,
  weeks,
  range,
  today,
  color,
  onColor,
}: {
  open: boolean;
  onClose: () => void;
  summary: UsageSummary;
  weeks: HeatmapCell[][];
  range: UsageRange;
  today: string;
  color: UsageColor;
  onColor: (color: UsageColor) => void;
}) {
  const [layout, setLayout] = useState<CardLayout>("landscape");
  const [look, setLook] = useState<CardLook>(() =>
    document.documentElement.dataset.appearance === "light" ? "light" : "dark",
  );
  const [busy, setBusy] = useState(false);
  const card = useRef<SVGSVGElement>(null);
  const toast = useToast();
  const auth = useAuth();
  const user = auth.state.status === "signed-in" ? auth.state.user : undefined;
  const [showIdentity, setShowIdentity] = useState(true);
  const avatar = useImageData(
    open && showIdentity ? user?.avatarUrl : undefined,
  );
  const identity =
    user && showIdentity
      ? { name: user.name, ...(avatar ? { avatar } : {}) }
      : undefined;

  async function withImage(
    use: (image: Blob) => Promise<void> | void,
  ): Promise<void> {
    if (!card.current) return;
    setBusy(true);
    try {
      await use(await svgToPng(card.current, 2));
    } catch {
      toast({ title: t("usage.share.failed"), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  // The write starts within the click and waits for the image itself, as
  // some browsers allow the clipboard only during the click.
  async function copyImage(): Promise<void> {
    if (!card.current) return;
    setBusy(true);
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": svgToPng(card.current, 2) }),
      ]);
      toast({ title: t("usage.share.copied"), tone: "success" });
    } catch {
      toast({ title: t("usage.share.failed"), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={t("usage.share.title")}
      description={t("usage.share.description")}
      footer={
        <>
          {user ? (
            <Checkbox
              checked={showIdentity}
              onChange={setShowIdentity}
              label={t("usage.share.identity")}
            />
          ) : null}
          <span className="usage-share-spacer" />
          <Button
            icon={<Copy size={14} />}
            disabled={busy}
            onClick={() => void copyImage()}
          >
            {t("usage.share.copy")}
          </Button>
          <Button
            variant="primary"
            icon={<Download size={14} />}
            disabled={busy}
            onClick={() =>
              void withImage((image) =>
                downloadAssetBlob(
                  image,
                  `ohmygame-usage-${layout}-${today}.png`,
                ),
              )
            }
          >
            {t("usage.share.save")}
          </Button>
        </>
      }
    >
      <div className="usage-share-controls">
        <SegmentedControl
          size="sm"
          label={t("usage.share.layout")}
          value={layout}
          options={CARD_LAYOUTS.map((value) => ({
            value,
            label: t(`usage.share.layouts.${value}`),
          }))}
          onChange={setLayout}
        />
        <SegmentedControl
          size="sm"
          label={t("usage.share.look")}
          value={look}
          options={[
            { value: "dark", label: t("usage.share.dark") },
            { value: "light", label: t("usage.share.light") },
          ]}
          onChange={setLook}
        />
        <UsageColorPicker value={color} onChange={onColor} />
      </div>
      <div className={`usage-share-preview is-${layout}`}>
        <UsageCard
          ref={card}
          layout={layout}
          look={look}
          color={color}
          summary={summary}
          weeks={weeks}
          range={range}
          today={today}
          identity={identity}
        />
      </div>
    </Dialog>
  );
}

/** Well above the largest avatar a card draws, so it stays sharp. */
const AVATAR_PIXELS = 256;

/**
 * An image as a data URL, so an exported SVG can show it: an SVG drawn as
 * an image doesn't load other files. It loads as an image because the app's
 * content policy lets images, not fetches, reach any host. Undefined until it
 * loads, or when its server doesn't allow reading it; the card then shows
 * initials.
 */
function useImageData(url: string | undefined): string | undefined {
  const [data, setData] = useState<{ url: string; value: string }>();
  useEffect(() => {
    if (!url || data?.url === url) return;
    let live = true;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    image.onload = () => {
      if (!live) return;
      const value = imageDataUrl(image);
      if (value) setData({ url, value });
    };
    image.src = url;
    return () => {
      live = false;
    };
  }, [url, data?.url]);
  return url && data?.url === url ? data.value : undefined;
}

function imageDataUrl(image: HTMLImageElement): string | undefined {
  const scale = Math.min(
    1,
    AVATAR_PIXELS / Math.min(image.naturalWidth, image.naturalHeight),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}
