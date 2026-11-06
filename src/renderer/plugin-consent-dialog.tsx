import { t } from "./i18n.js";
import { Alert, Button, Dialog } from "./ui/index.js";

/** Native code isn't sandboxed, so asking for it gets a warning wherever it is allowed. */
export function NativeCodeWarning({ asks }: { asks: readonly string[] }) {
  return asks.includes("native") ? <Alert tone="danger" title={t("projectPlugins.nativeWarning")}>{t("projectPlugins.nativeWarningHint")}</Alert> : null;
}

/**
 * Asks the person to allow what a plugin asks for before it is turned on: in
 * a project, or in every project it suits, where it then runs in each one.
 */
export function PluginConsentDialog({ name, capabilities, everyProject = false, onAllow, onCancel }: {
  name: string;
  capabilities: readonly string[];
  everyProject?: boolean;
  onAllow: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open title={t("projectPlugins.consentTitle", { name })} onClose={onCancel}
      footer={<>
        <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={onAllow}>{t("projectPlugins.allow")}</Button>
      </>}>
      <p>{t("projectPlugins.consentHint")}</p>
      <ul className="project-plugins-capabilities">
        {capabilities.map((capability) => <li key={capability}><code>{capability}</code></li>)}
      </ul>
      {everyProject ? <p>{t("projectPlugins.consentEveryProject")}</p> : null}
      <NativeCodeWarning asks={capabilities} />
    </Dialog>
  );
}
