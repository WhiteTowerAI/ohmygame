import { useState } from "react";
import type { PluginDraft, PluginDraftRun } from "../shared/plugin-setup.js";
import { runPluginDraft } from "./api.js";
import type { StorePlugin } from "../shared/plugins.js";
import { Bell, Check, CircleX, LoaderCircle, Play, Plug, Terminal, Wrench } from "./icons.js";
import { t } from "./i18n.js";
import { NativeCodeWarning, PluginCapabilityList } from "./plugin-consent-dialog.js";
import { PluginGlyph } from "./plugin-icons.js";
import { StorePluginSettings, storePluginEnabled, type useEveryProjectSwitch } from "./plugin-store.js";
import { PluginAddsList, pluginAddRows, PluginHead, type PluginAddRow } from "./plugin-summary.js";
import { Alert, Badge, Button, Dialog, Disclosure, Field, Switch, Textarea } from "./ui/index.js";

type DraftCheck = "failed" | "untested" | "passed";

function currentResult(draft: PluginDraft, server: string) {
  const check = draft.checks?.[server];
  return check?.revision === draft.revision ? check?.result : undefined;
}

/** Where the draft stands: a service only counts once it connected in this revision. */
export function draftCheck(draft: PluginDraft): DraftCheck {
  if (draft.errors.length) return "failed";
  const results = (draft.plugin?.mcpServers ?? []).map(server => currentResult(draft, server.id));
  if (results.some(result => result && result.status !== "connected")) return "failed";
  return results.every(Boolean) ? "passed" : "untested";
}

export function draftCheckLabel(check: DraftCheck): string {
  return t(check === "failed" ? "pluginBuilder.needsChanges" : check === "untested" ? "pluginBuilder.servicesNotTested" : "pluginBuilder.checksPassed");
}

/**
 * The draft as its plugin page will read: what it adds and asks for, its
 * settings once installed, and the checks, which open only when one needs you.
 */
export function PluginOverview({ draft, setupId, stored, disabled, operation, everyProject, onEditIcon, onOpenFile, onTest, onAllowRun }: {
  draft: PluginDraft;
  setupId: string;
  /** The installed version, when there is one. */
  stored?: StorePlugin;
  disabled: boolean;
  operation?: string;
  everyProject: ReturnType<typeof useEveryProjectSwitch>;
  onEditIcon?: () => void;
  onOpenFile: (file: string) => void;
  onTest: (server: string) => void;
  /** Allows the draft's native code to run here, as it asks for `key`. */
  onAllowRun: (key: string) => void;
}) {
  const plugin = draft.plugin;
  const checks = <DraftChecks draft={draft} disabled={disabled} operation={operation} onTest={onTest} />;
  if (!plugin) return <div className="plugins-page plugin-builder-overview">{checks}</div>;
  const rows: PluginAddRow[] = [
    ...plugin.skills.map(skill => ({ id: `skill:${skill.id}`, kind: t("plugins.skills"), title: <button className="plugin-builder-link" type="button" title={skill.description} onClick={() => onOpenFile(skill.id)}>{skill.name}</button> })),
    ...pluginAddRows({ ...plugin.adds, skills: 0 }),
  ];
  const tile = <span className="plugin-tile plugin-tile-large"><PluginGlyph plugin={plugin} size={40} setupId={setupId} /></span>;
  return <div className="plugins-page plugin-builder-overview">
    <PluginHead title={plugin.displayName} description={plugin.description} badges={plugin.version ? <Badge tone="outline">v{plugin.version}</Badge> : null}
      tile={onEditIcon ? <button className="plugin-builder-icon-button" type="button" aria-label={t("pluginIconPicker.change")} title={t("pluginIconPicker.change")} disabled={disabled} onClick={onEditIcon}>{tile}</button> : tile} />
    <p className="plugin-long">{t(plugin.appWide ? "pluginBuilder.scopeAppWide" : "pluginBuilder.scopePerProject")}</p>
    {rows.length ? <section className="plugins-section" aria-label={t("pluginStore.adds")}>
      <h2>{t("pluginStore.adds")}</h2>
      <PluginAddsList rows={rows} />
    </section> : null}
    {plugin.asks.length ? <section className="plugins-section" aria-label={t("pluginStore.asksFor")}>
      <h2>{t("pluginStore.asksFor")}</h2>
      <PluginCapabilityList capabilities={plugin.asks} />
      <NativeCodeWarning asks={plugin.asks} />
    </section> : null}
    {stored?.settings.length ? <fieldset className="plugin-builder-config" disabled={disabled}><StorePluginSettings key={stored.revision} plugin={stored} /></fieldset>
      : plugin.settings ? <section className="plugins-section" aria-label={t("common.settings")}>
        <h2>{t("common.settings")}</h2>
        <p className="plugins-note">{t("pluginBuilder.settingsAfterInstall")}</p>
      </section> : null}
    {stored && storePluginEnabled(stored) ? <section className="plugins-section" aria-label={t("plugins.management")}>
      <h2>{t("plugins.management")}</h2>
      <dl className="plugin-props">
        <dt>{t("plugins.everyProject")}</dt>
        <dd className="plugin-state">
          <Switch size="sm" checked={stored.everyProject} disabled={disabled || Boolean(everyProject.busy)}
            label={t("plugins.everyProjectSwitch", { name: stored.displayName })} onChange={on => everyProject.toggle(stored, on)} />
          <span>{stored.everyProject ? t("plugins.scopeEveryProject") : t("plugins.scopeSomeProjects")}</span>
        </dd>
      </dl>
    </section> : null}
    {checks}
    <DraftCode draft={draft} setupId={setupId} disabled={disabled} operation={operation} onAllow={onAllowRun} />
  </div>;
}

type RunTarget = { kind: "tool" | "command" | "hook"; name: string; title: string; input?: unknown; takesInput: boolean };

/**
 * The draft's native code, to try before it is installed: once the person
 * allows what it asks for, each tool, command and hook runs here, with the
 * workspace's playground as its project.
 */
function DraftCode({ draft, setupId, disabled, operation, onAllow }: {
  draft: PluginDraft; setupId: string; disabled: boolean; operation?: string; onAllow: (key: string) => void;
}) {
  const [target, setTarget] = useState<RunTarget>();
  const plugin = draft.plugin;
  const native = plugin?.native;
  if (!plugin || !native || draft.errors.length) return null;
  const targets: Array<RunTarget & { Icon: typeof Wrench }> = [
    ...native.tools.map(tool => ({ kind: "tool" as const, name: tool.name, title: tool.name, input: tool.input, takesInput: true, Icon: Wrench })),
    ...native.commands.map(command => ({ kind: "command" as const, name: command.id, title: command.title, input: command.input, takesInput: command.input !== undefined, Icon: Terminal })),
    ...native.hooks.map(hook => ({ kind: "hook" as const, name: hook, title: hook, takesInput: true, Icon: Bell })),
  ];
  return <section className="plugins-section" aria-label={t("pluginBuilder.tryCode")}>
    <h2>{t("pluginBuilder.tryCode")}</h2>
    {draft.runAllowed ? <>
      <p className="plugins-note">{t("pluginBuilder.tryCodeHint")}</p>
      {targets.map(({ Icon, ...item }) => <div className="plugin-builder-check" key={`${item.kind}:${item.name}`}>
        <Icon size={16} /><strong>{item.title}</strong><small>{t(`pluginBuilder.runKind.${item.kind}`)}</small>
        <Button size="sm" icon={<Play size={12} />} disabled={disabled} aria-label={t("pluginBuilder.runNamed", { name: item.title })} onClick={() => setTarget(item)}>{t("pluginBuilder.run")}</Button>
      </div>)}
    </> : <>
      <p className="plugins-note">{t("pluginBuilder.allowRunHint")}</p>
      <PluginCapabilityList capabilities={plugin.asks} />
      <NativeCodeWarning asks={plugin.asks} />
      <div><Button size="sm" disabled={disabled} icon={operation === "allowing-run" ? <LoaderCircle className="spin" size={12} /> : undefined}
        onClick={() => onAllow(native.key)}>{t("pluginBuilder.allowRun")}</Button></div>
    </>}
    {target ? <DraftRunDialog setupId={setupId} target={target} onClose={() => setTarget(undefined)} /> : null}
  </section>;
}

/** Runs one tool, command or hook with input the person writes, and shows what came back. */
function DraftRunDialog({ setupId, target, onClose }: { setupId: string; target: RunTarget; onClose: () => void }) {
  const [text, setText] = useState(() => JSON.stringify(inputSkeleton(target.input), null, 2));
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<PluginDraftRun>();
  const [error, setError] = useState<string>();
  async function run() {
    let input: unknown;
    if (target.takesInput) {
      try { input = JSON.parse(text); }
      catch { setError(t("pluginBuilder.inputNotJson")); return; }
    }
    setRunning(true); setError(undefined); setOutcome(undefined);
    try { setOutcome(await runPluginDraft(setupId, { [target.kind]: target.name } as { tool: string }, input)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRunning(false); }
  }
  return <Dialog open onClose={onClose} title={t("pluginBuilder.runNamed", { name: target.title })} description={t("pluginBuilder.runDescription")}
    footer={<>
      <Button onClick={onClose}>{t("common.close")}</Button>
      <Button variant="primary" disabled={running} icon={running ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />} onClick={() => void run()}>{t("pluginBuilder.run")}</Button>
    </>}>
    <div className="plugin-builder-run">
      {target.takesInput ? <Field label={t(target.kind === "hook" ? "pluginBuilder.hookEvent" : "pluginBuilder.input")}>
        {props => <Textarea {...props} className="plugin-builder-run-input" rows={6} spellCheck={false} value={text} onChange={event => setText(event.target.value)} />}
      </Field> : null}
      {error ? <Alert tone="danger" title={error} /> : null}
      {outcome ? outcome.ok
        ? <Field label={t("pluginBuilder.result")}>{() => <pre className="plugin-builder-run-output">{JSON.stringify(outcome.result ?? null, null, 2)}</pre>}</Field>
        : <Alert tone="danger" title={outcome.error ?? t("pluginBuilder.runFailed")} /> : null}
      {outcome?.log.length ? <Field label={t("pluginBuilder.runLog")}>{() => <pre className="plugin-builder-run-output">{outcome.log.map(entry => `${entry.level}: ${entry.text}`).join("\n")}</pre>}</Field> : null}
    </div>
  </Dialog>;
}

/** A starting input from a JSON Schema: each required property with an empty value of its type. */
function inputSkeleton(schema: unknown): unknown {
  const value = schema as { type?: string; properties?: Record<string, { type?: string; default?: unknown }>; required?: string[] } | undefined;
  if (!value || value.type !== "object" || !value.properties) return {};
  const empty: Record<string, unknown> = { string: "", number: 0, integer: 0, boolean: false, array: [], object: {} };
  return Object.fromEntries((value.required ?? []).map(name => {
    const property = value.properties![name];
    return [name, property?.default ?? empty[property?.type ?? "string"] ?? null];
  }));
}

function DraftChecks({ draft, disabled, operation, onTest }: {
  draft: PluginDraft; disabled: boolean; operation?: string; onTest: (server: string) => void;
}) {
  const check = draftCheck(draft);
  // Until you choose, it follows the result: a new problem opens it.
  const [open, setOpen] = useState<boolean>();
  return <Disclosure variant="section" className="plugin-builder-checks" open={open ?? check !== "passed"} onOpenChange={setOpen}
    summary={<>{t("pluginBuilder.checks")}<small className={`plugin-builder-check-result is-${check}`}>{draftCheckLabel(check)}</small></>}>
    <div className={`plugin-builder-check ${draft.errors.length ? "has-error" : "is-passed"}`}>
      {draft.errors.length ? <CircleX size={16} /> : <Check size={16} />}<strong>{t("pluginBuilder.packageStructure")}</strong>
      <small>{draft.errors.length ? t("pluginBuilder.needsChanges") : t("pluginBuilder.passed")}</small>
    </div>
    {draft.errors.map(error => <p className="plugin-builder-error" role="alert" key={error}>{error}</p>)}
    {draft.plugin?.mcpServers.map(server => {
      const result = currentResult(draft, server.id);
      return <div key={server.id}>
        <div className="plugin-builder-check">
          <Plug size={16} /><strong>{server.title}</strong>
          <small>{result?.status === "connected" ? t("pluginBuilder.connectedTools", { count: result.toolCount }) : result?.status === "needs-auth" ? t("pluginControls.authorizationRequired") : result?.status === "failed" ? t("providers.status.failed") : draft.checks?.[server.id] ? t("pluginBuilder.outdated") : t("pluginBuilder.notTested")}</small>
          <Button size="sm" aria-label={t("pluginBuilder.testServer", { name: server.title })} disabled={disabled || Boolean(draft.errors.length)}
            icon={operation === `test:${server.id}` ? <LoaderCircle className="spin" size={12} /> : undefined} onClick={() => onTest(server.id)}>{t("pluginControls.test")}</Button>
        </div>
        {result?.message && result.status !== "connected" ? <Disclosure summary={t("common.details")}><pre>{result.message}</pre></Disclosure> : null}
      </div>;
    })}
  </Disclosure>;
}
