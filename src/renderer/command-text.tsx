import { useEffect, useState } from "react";
import { Check, Copy } from "./icons.js";
import { IconButton } from "./ui/index.js";
import { t } from "./i18n.js";

/** A command or link shown as code, with a button that copies it. */
export function CommandText({
  command,
  copyLabel,
}: {
  command: string;
  copyLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <span className="settings-command coding-agent-command">
      <code>{command}</code>
      <IconButton
        size="sm"
        label={
          copied
            ? t("codingAgents.copied")
            : (copyLabel ?? t("codingAgents.copyCommand"))
        }
        onClick={() =>
          void navigator.clipboard.writeText(command).then(
            () => setCopied(true),
            () => undefined,
          )
        }
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </IconButton>
    </span>
  );
}
