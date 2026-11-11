import { useEffect, useState } from "react";
import { PLUGIN_FILE_MIRRORS } from "../shared/plugins.js";
import { getPluginFileMirror, setPluginFileMirror } from "./api.js";
import { t } from "./i18n.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { SettingsGroup, SettingsNote, SettingsRow } from "./settings-parts.js";
import { Button, Field, Input, SegmentedControl } from "./ui/index.js";

type Choice = keyof typeof PLUGIN_FILE_MIRRORS | "custom";

const presetOf = (base: string): Choice =>
  (Object.keys(PLUGIN_FILE_MIRRORS) as (keyof typeof PLUGIN_FILE_MIRRORS)[]).find((key) => PLUGIN_FILE_MIRRORS[key] === base) ?? "custom";

/**
 * Where the market's plugin icons and screenshots come from: jsDelivr, unpkg,
 * or the address of another CDN (or a proxy of one) for npm packages. A
 * preset applies when picked; an address when it's saved.
 */
export function PluginFileSettings() {
  const generation = useReadyRuntimeGeneration();
  const [base, setBase] = useState<string>();
  const [choice, setChoice] = useState<Choice>("jsdelivr");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "success" | "danger"; text: string }>();

  useEffect(() => {
    let live = true;
    void getPluginFileMirror().then(({ base: next }) => {
      if (!live) return;
      setBase(next);
      setChoice(presetOf(next));
      if (presetOf(next) === "custom") setDraft(next);
    }, (cause) => { if (live) setNote({ tone: "danger", text: errorText(cause) }); });
    return () => { live = false; };
  }, [generation]);

  async function save(next: string) {
    setBusy(true);
    setNote(undefined);
    try {
      const saved = await setPluginFileMirror(next);
      setBase(saved.base);
      if (presetOf(saved.base) === "custom") setDraft(saved.base);
      setNote({ tone: "success", text: t("network.saved") });
    } catch (cause) {
      setNote({ tone: "danger", text: errorText(cause) });
    } finally {
      setBusy(false);
    }
  }

  function pick(next: Choice) {
    setChoice(next);
    setNote(undefined);
    if (next !== "custom" && PLUGIN_FILE_MIRRORS[next] !== base) void save(PLUGIN_FILE_MIRRORS[next]);
  }

  if (base === undefined) return note ? <SettingsNote tone={note.tone}>{note.text}</SettingsNote> : null;
  return (
    <SettingsGroup title={t("network.pluginFiles.title")} description={t("network.pluginFiles.description")}>
      <SettingsRow title={t("network.pluginFiles.source")}>
        <SegmentedControl
          size="sm"
          label={t("network.pluginFiles.sourceLabel")}
          value={choice}
          onChange={pick}
          options={[
            { value: "jsdelivr", label: "jsDelivr", disabled: busy },
            { value: "unpkg", label: "unpkg", disabled: busy },
            { value: "custom", label: t("network.pluginFiles.custom"), disabled: busy },
          ]}
        />
      </SettingsRow>
      {choice === "custom" ? (
        <form className="settings-pad settings-form" onSubmit={(event) => { event.preventDefault(); void save(draft); }}>
          <Field label={t("network.pluginFiles.address")} hint={t("network.pluginFiles.addressHint", { example: "@scope/name@1.0.0/icon.svg" })}>
            {(props) => (
              <Input
                {...props}
                type="url"
                required
                placeholder={PLUGIN_FILE_MIRRORS.jsdelivr}
                value={draft}
                disabled={busy}
                onChange={(event) => { setDraft(event.target.value); setNote(undefined); }}
                spellCheck={false}
                autoComplete="off"
              />
            )}
          </Field>
          <div className="settings-actions">
            <Button variant="primary" type="submit" disabled={busy || !draft.trim() || draft.trim() === base}>
              {busy ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </form>
      ) : null}
      {note ? <div className="settings-pad"><SettingsNote tone={note.tone} {...(note.tone === "success" ? { role: "status" as const } : {})}>{note.text}</SettingsNote></div> : null}
    </SettingsGroup>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
