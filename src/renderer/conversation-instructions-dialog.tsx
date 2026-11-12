import { useEffect, useState } from "react";
import type { ConversationInstructions } from "../shared/agent-instructions.js";
import { getConversationInstructions } from "./api.js";
import { LoaderCircle } from "./icons.js";
import { Button, CodeBlock, Collapsible, Dialog } from "./ui/index.js";
import { t } from "./i18n.js";

/** Names for the system prompt's sections; one the app doesn't know keeps its own name. */
const SECTION_LABELS: Record<string, () => string> = {
  base: () => t("conversationInstructions.section.base"),
  preamble: () => t("conversationInstructions.section.preamble"),
  tools: () => t("conversationInstructions.section.tools"),
  rules: () => t("conversationInstructions.section.rules"),
  docs: () => t("conversationInstructions.section.docs"),
  addendum: () => t("conversationInstructions.section.addendum"),
  project_context: () => t("conversationInstructions.section.projectContext"),
  skills: () => t("conversationInstructions.section.skills"),
  cwd: () => t("conversationInstructions.section.cwd"),
};

function sectionLabel(name: string): string {
  return SECTION_LABELS[name]?.() ?? name;
}

/**
 * What a conversation's agent is told, as its model last received it: every
 * section of the system prompt and every tool, so nothing is hidden. A coding
 * agent's own instructions are its own; only what OhMyGame adds is shown.
 */
export function ConversationInstructionsDialog({ projectId, conversationId, onClose }: { projectId: string; conversationId: string; onClose: () => void }) {
  const [instructions, setInstructions] = useState<ConversationInstructions>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setInstructions(undefined);
    setError(undefined);
    getConversationInstructions(projectId, conversationId)
      .then((loaded) => { if (active) setInstructions(loaded); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [projectId, conversationId]);

  const all = instructions?.kind === "ohmygame"
    ? instructions.sections.map((section) => section.text).join("\n\n")
    : instructions?.text ?? "";

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={t("conversationInstructions.title")}
      description={instructions?.kind === "coding-agent" ? t("conversationInstructions.codingAgent") : t("conversationInstructions.description")}
      footer={<>
        {all ? <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(all).catch(() => undefined)}>{t("conversationInstructions.copyAll")}</Button> : null}
        <Button onClick={onClose}>{t("common.close")}</Button>
      </>}
    >
      <div className="conversation-instructions">
        {error ? <p className="settings-error" role="alert">{error}</p> : null}
        {!instructions && !error ? <div className="settings-loading-row"><LoaderCircle className="spin" size={16} />{t("common.loading")}</div> : null}
        {instructions?.kind === "coding-agent" ? <CodeBlock title={t("conversationInstructions.section.addendum")} code={instructions.text} /> : null}
        {instructions?.kind === "ohmygame" && !instructions.started ? <p className="settings-detail-hint">{t("conversationInstructions.notStarted")}</p> : null}
        {instructions?.kind === "ohmygame" && instructions.started ? <>
          {instructions.sections.map((section) => (
            <Collapsible key={section.name} title={sectionLabel(section.name)} meta={t("conversationInstructions.characters", { count: section.text.length })} defaultOpen={section.name === "addendum"}>
              <CodeBlock title={sectionLabel(section.name)} code={section.text} />
            </Collapsible>
          ))}
          <Collapsible title={t("conversationInstructions.tools")} meta={t("conversationInstructions.toolCount", { count: instructions.tools.length })}>
            <ul className="conversation-instructions-tools">
              {instructions.tools.map((tool) => <li key={tool.name}><code>{tool.name}</code><span>{tool.description}</span></li>)}
            </ul>
          </Collapsible>
        </> : null}
      </div>
    </Dialog>
  );
}
