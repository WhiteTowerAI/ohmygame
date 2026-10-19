import { useEffect, useRef, useState } from "react";
import type { ThreadItem } from "../shared/contracts.js";
import type {
  ApprovalDecision,
  ApprovalRequestDetails,
} from "../shared/agent-runtimes.js";
import { Terminal } from "./icons.js";
import { t } from "./i18n.js";

interface ApprovalCardProps {
  request: Extract<ThreadItem, { type: "approvalRequest" }>;
  /** The coding agent's name, such as Claude Code. */
  agentName?: string;
  /** How many more requests wait behind this one. */
  waiting: number;
  onDecide: (decision: ApprovalDecision) => Promise<boolean>;
}

/** A coding agent asks before it does something OhMyGame does not allow on its own. */
export function ApprovalCard({
  request,
  agentName,
  waiting,
  onDecide,
}: ApprovalCardProps) {
  const [submitting, setSubmitting] = useState(false);
  // A second click can arrive before the disabled buttons render; one answer is sent per request.
  const answering = useRef(false);
  useEffect(() => {
    answering.current = false;
    setSubmitting(false);
  }, [request.requestId]);
  const details = request.request;
  const agent = agentName ?? t("approval.theAgent");
  const title =
    details.kind === "command"
      ? t("approval.commandTitle", { agent })
      : details.kind === "file"
        ? t("approval.fileTitle", { agent })
        : details.kind === "tool"
          ? t("approval.toolTitle", {
              agent,
              tool: details.title ?? details.tool,
            })
          : t("approval.otherTitle", { agent });
  async function decide(decision: ApprovalDecision) {
    if (answering.current) return;
    answering.current = true;
    setSubmitting(true);
    let answered = false;
    try {
      answered = await onDecide(decision);
    } catch {
      /* The parent displays the request error. */
    }
    if (!answered) {
      answering.current = false;
      setSubmitting(false);
    }
  }
  return (
    <section
      className="questionnaire-card approval-card"
      aria-label={t("approval.label")}
    >
      <header>
        <Terminal size={14} aria-hidden="true" />
        <strong>{title}</strong>
        {waiting > 0 ? (
          <small>{t("approval.waiting", { count: waiting })}</small>
        ) : null}
      </header>
      {details.command !== undefined ? (
        <pre className="approval-card-detail">
          <code>{details.command}</code>
        </pre>
      ) : null}
      {details.path ? (
        <p className="approval-card-path">
          <code>{details.path}</code>
        </p>
      ) : null}
      {details.reason ? (
        <p className="approval-card-reason">{details.reason}</p>
      ) : null}
      {details.paths?.length ? (
        <ul>
          {details.paths.map((entry, index) => (
            <li key={`${entry.path}:${index}`}>
              <span>
                {t(
                  entry.access === "read"
                    ? "approval.readAccess"
                    : "approval.writeAccess",
                )}
              </span>{" "}
              <code>{entry.path}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {details.network ? <p>{t("approval.networkAccess")}</p> : null}
      <footer>
        <button
          type="button"
          className="settings-secondary-button"
          disabled={submitting}
          onClick={() => void decide("deny")}
        >
          {t("approval.deny")}
        </button>
        {details.canAllowSession ? (
          <button
            type="button"
            className="settings-secondary-button"
            disabled={submitting}
            onClick={() => void decide("allow-session")}
            title={sessionScopeTitle(details.sessionScope)}
          >
            {sessionLabel(details.sessionScope)}
          </button>
        ) : null}
        <button
          type="button"
          className="settings-primary-button"
          disabled={submitting}
          onClick={() => void decide("allow")}
        >
          {t("approval.allow")}
        </button>
      </footer>
    </section>
  );
}

/** One line in the conversation for a request that was answered or let go. */
export function approvalOutcomeLabel(
  item: Extract<ThreadItem, { type: "approvalRequest" }>,
): string {
  const subject =
    item.request.command ??
    item.request.path ??
    (item.request.paths?.length
      ? item.request.paths.map((entry) => entry.path).join(", ")
      : undefined) ??
    (item.request.network ? t("approval.networkAccess") : undefined) ??
    item.request.title ??
    item.request.tool;
  if (item.status === "completed" && item.decision === "allow")
    return t("approval.allowed", { subject });
  if (item.status === "completed" && item.decision === "allow-session")
    return t("approval.allowedSession", { subject });
  if (item.status === "completed") return t("approval.denied", { subject });
  return t("approval.notAnswered", { subject });
}

type SessionScope = NonNullable<ApprovalRequestDetails["sessionScope"]>;

/** Names what allowing for the conversation covers when it is more than this request. */
function sessionLabel(scope: SessionScope | undefined): string {
  if (scope?.commands?.length && !scope.readFolders?.length)
    return t("approval.allowSessionCommands", {
      commands: scope.commands.join(", "),
    });
  if (scope?.readFolders?.length && !scope.commands?.length)
    return t("approval.allowSessionFolders", {
      folders: scope.readFolders.map(folderName).join(", "),
    });
  return t("approval.allowSession");
}

function sessionScopeTitle(
  scope: SessionScope | undefined,
): string | undefined {
  const folders = scope?.readFolders ?? [];
  return folders.length ? folders.join("\n") : undefined;
}

function folderName(folder: string): string {
  return `${folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder}/`;
}
