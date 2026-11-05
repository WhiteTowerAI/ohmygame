import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { AccountRuntimeId, AgentAccountProfileStatus } from "../shared/agent-runtimes.js";
import type { AgentUsageLimit } from "../shared/contracts.js";
import { currentUsage, usageLevel, usageResetLabel, usageWindowLabel } from "./agent-usage.js";
import { Check, ChevronDown, RefreshCw, Settings, UserRound } from "./icons.js";
import { t } from "./i18n.js";
import { settingsHash } from "./routes.js";
import { IconButton, Popover } from "./ui/index.js";

/** How often an open menu recounts the time left before each window resets. */
const CLOCK_MS = 30_000;
const CARD_WIDTH = 240;

function profileName(profile: AgentAccountProfileStatus): string {
  return profile.id === "system" ? t("codingAgents.profileSystem") : profile.name;
}

/** The window closest to its limit: the one that stops the account first. */
function busiest(limits: readonly AgentUsageLimit[]): AgentUsageLimit | undefined {
  return limits.reduce<AgentUsageLimit | undefined>((top, limit) => (!top || limit.usedPercent > top.usedPercent ? limit : top), undefined);
}

/** Each window with its share used, a bar and how long until it resets. */
function UsageWindows({ limits, now }: { limits: readonly AgentUsageLimit[]; now: number }) {
  return <div className="agent-account-windows">
    {limits.map((limit) => {
      const percent = Math.round(limit.usedPercent);
      const reset = usageResetLabel(limit, now);
      return <div className={`agent-account-window${usageLevel(percent)}`} key={limit.id}>
        <span className="agent-account-window-head"><span>{usageWindowLabel(limit)}</span><span>{percent}%</span></span>
        <span className="agent-account-bar" role="meter" aria-label={usageWindowLabel(limit)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
          aria-valuetext={t("agentUsage.used", { percent })}><span style={{ width: `${percent}%` }} /></span>
        {reset ? <small>{reset}</small> : null}
      </div>;
    })}
  </div>;
}

/**
 * The chat header's account menu for Claude Code and Codex: the chosen
 * account's quota windows and when they reset, then every account with its
 * busiest window. Hovering an account shows its windows beside the menu, so
 * the person can move to one with room left.
 */
export function AgentAccountMenu({ runtime, profiles, value, disabled, onChange, onRefresh }: {
  runtime: AccountRuntimeId;
  profiles: readonly AgentAccountProfileStatus[];
  value: string;
  disabled: boolean;
  onChange: (profileId: string) => void;
  /** Checks every account again; the new list arrives through `profiles`. */
  onRefresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [refreshing, setRefreshing] = useState(false);
  const [peek, setPeek] = useState<{ id: string; style: CSSProperties }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) { setPeek(undefined); return; }
    setNow(Date.now());
    const clock = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(clock);
  }, [open]);

  // A card with many windows moves up to stay on screen once its height is known.
  useLayoutEffect(() => {
    const height = card.current?.offsetHeight;
    const top = Number(peek?.style.top);
    if (!peek || !height || top + height <= window.innerHeight - 8) return;
    setPeek({ ...peek, style: { ...peek.style, top: Math.max(8, window.innerHeight - 8 - height) } });
  }, [peek]);

  const selected = profiles.find((profile) => profile.id === value) ?? profiles[0];
  if (!selected) return null;
  const agent = runtime === "codex-cli" ? "Codex" : "Claude Code";
  const label = t("codingAgents.chatProfile", { name: agent });
  const limitsOf = (profile: AgentAccountProfileStatus) => (profile.limits ?? []).map((limit) => currentUsage(limit, now));
  const selectedLimits = limitsOf(selected);
  const top = busiest(selectedLimits);
  const topPercent = top ? Math.round(top.usedPercent) : undefined;
  const peeked = peek && profiles.find((profile) => profile.id === peek.id);

  /** Beside the menu, level with the row: on the right when it fits, else on the left. */
  function showPeek(profile: AgentAccountProfileStatus, row: HTMLElement) {
    // The chosen account's windows are already at the top of the menu.
    if (!profile.limits?.length || profile.id === selected!.id) { setPeek(undefined); return; }
    const menu = row.closest(".agent-account-menu")!.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    const left = menu.right + 6 + CARD_WIDTH <= window.innerWidth - 8 ? menu.right + 6 : Math.max(8, menu.left - 6 - CARD_WIDTH);
    setPeek({ id: profile.id, style: { top: Math.max(8, at.top - 8), left, width: CARD_WIDTH } });
  }

  return <>
    <button ref={trigger} type="button" className="agent-account-trigger" disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
      aria-label={`${label}: ${profileName(selected)}`} title={selected.auth.account ?? profileName(selected)} onClick={() => setOpen(!open)}>
      <UserRound size={13} aria-hidden="true" />
      <span className="agent-account-trigger-name">{profileName(selected)}</span>
      {topPercent !== undefined ? <span className={`agent-account-trigger-usage${usageLevel(topPercent)}`}>{topPercent}%</span> : null}
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    <Popover open={open} onClose={() => setOpen(false)} anchor={trigger} placement="bottom-end" className="agent-account-menu" label={label}>
      <div className="agent-account-current">
        <strong title={selected.auth.account}>{selected.auth.account ?? profileName(selected)}</strong>
        <small>{selected.auth.account ? `${profileName(selected)} · ${t("codingAgents.accountCurrent")}` : t("codingAgents.accountCurrent")}</small>
      </div>
      {selectedLimits.length ? <UsageWindows limits={selectedLimits} now={now} />
        : <p className="agent-account-empty">{t(selected.auth.status === "signed-out" ? "codingAgents.signedOut" : "codingAgents.accountNoUsage")}</p>}
      <div className="ui-menu-separator" />
      <div className="agent-account-heading">
        <span>{t("codingAgents.accountList")}</span>
        <IconButton size="sm" label={t("codingAgents.profileRecheck")} disabled={refreshing} onClick={() => {
          setRefreshing(true);
          void onRefresh().finally(() => setRefreshing(false));
        }}><RefreshCw size={13} className={refreshing ? "spin" : undefined} /></IconButton>
      </div>
      <div className="agent-account-list" role="radiogroup" aria-label={label} onPointerLeave={() => setPeek(undefined)}>
        {profiles.map((profile) => {
          const limits = limitsOf(profile);
          const peak = busiest(limits);
          const percent = peak ? Math.round(peak.usedPercent) : undefined;
          const active = profile.id === selected.id;
          return <button type="button" role="radio" aria-checked={active} key={profile.id} className="agent-account-row" disabled={disabled}
            onPointerEnter={(event) => showPeek(profile, event.currentTarget)} onFocus={(event) => showPeek(profile, event.currentTarget)}
            onBlur={() => setPeek(undefined)}
            onClick={() => { setOpen(false); if (!active) onChange(profile.id); }}>
            <span className="agent-account-row-text">
              <span>{profileName(profile)}</span>
              <small>{profile.auth.account ?? (profile.auth.status === "signed-out" ? t("codingAgents.signedOut") : "")}</small>
            </span>
            {limits.length ? <span className="agent-account-mini" aria-hidden="true">
              {limits.slice(0, 2).map((limit) => <span key={limit.id} className={usageLevel(Math.round(limit.usedPercent)).trim()}><span style={{ width: `${Math.round(limit.usedPercent)}%` }} /></span>)}
            </span> : null}
            {percent !== undefined ? <span className={`agent-account-row-usage${usageLevel(percent)}`}>{percent}%</span> : null}
            <span className="agent-account-check">{active ? <Check size={14} /> : null}</span>
          </button>;
        })}
      </div>
      <div className="ui-menu-separator" />
      <button type="button" className="ui-menu-item" onClick={() => { setOpen(false); window.location.hash = settingsHash("agents", runtime); }}>
        <span className="ui-menu-icon"><Settings size={14} /></span>
        <span className="ui-menu-label">{t("codingAgents.accountManage")}</span>
      </button>
    </Popover>
    {open && peeked ? createPortal(<div ref={card} className="agent-account-peek" style={peek.style} role="tooltip" data-native-preview-overlay>
      <strong>{peeked.auth.account ?? profileName(peeked)}</strong>
      <UsageWindows limits={limitsOf(peeked)} now={now} />
    </div>, document.body) : null}
  </>;
}
