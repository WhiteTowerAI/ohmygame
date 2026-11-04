import { Clock, CornerDownRight, Pencil, Trash2 } from "./icons.js";
import type { PendingPrompt, ScheduledMessage } from "../shared/contracts.js";
import { t } from "./i18n.js";
import { scheduleTime } from "./later-command.js";

interface MessageQueueProps {
  items: PendingPrompt[];
  disabled: boolean;
  prioritizeOnly?: boolean;
  onRemove: (turnId: string) => void;
  onSteer: (turnId: string) => void;
  onEdit: (item: PendingPrompt) => void;
}

export function MessageQueue({ items, disabled, prioritizeOnly = false, onRemove, onSteer, onEdit }: MessageQueueProps) {
  if (items.length === 0) return null;

  return (
    <div className="message-queue" aria-label={t("queue.label")}>
      {items.map((item) => (
        <QueueRow key={item.turnId} item={item} disabled={disabled} prioritizeOnly={prioritizeOnly} onEdit={onEdit} onSteer={onSteer} onRemove={onRemove} />
      ))}
    </div>
  );
}

function QueueRow({ item, disabled, prioritizeOnly, onEdit, onSteer, onRemove }: {
  item: PendingPrompt;
  disabled: boolean;
  prioritizeOnly: boolean;
  onEdit: (item: PendingPrompt) => void;
  onSteer: (turnId: string) => void;
  onRemove: (turnId: string) => void;
}) {
  const canEdit = editable(item);
  return (
    <div className="message-queue-row">
      <CornerDownRight className="message-queue-marker" size={10} aria-hidden="true" />
      <span className="message-queue-text" title={item.prompt}>
        {item.prompt || `${item.images.length} image${item.images.length === 1 ? "" : "s"}`}
      </span>
      <div className="message-queue-actions">
        <button
          type="button"
          disabled={disabled || !canEdit}
          onClick={() => onEdit(item)}
          title={canEdit ? t("queue.editTitle") : t("queue.editAttachments")}
          aria-label={t("queue.editTitle")}
        >
          <Pencil size={12} />
        </button>
        <button type="button" disabled={disabled} onClick={() => onSteer(item.turnId)} title={t(prioritizeOnly ? "queue.prioritizeTitle" : "queue.steerTitle")}>
          <CornerDownRight size={12} />
          <span>{t(prioritizeOnly ? "queue.prioritize" : "queue.steer")}</span>
        </button>
        <button type="button" disabled={disabled} onClick={() => onRemove(item.turnId)} title={t("queue.remove")} aria-label={t("queue.remove")}>
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

export function ScheduledMessages({ items, disabled, editDisabled, onEdit, onRemove }: {
  items: ScheduledMessage[];
  disabled: boolean;
  editDisabled: boolean;
  onEdit: (item: ScheduledMessage) => void;
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="message-queue" aria-label={t("later.label")}>
      {items.map((item) => (
        <div className="message-queue-row" key={item.id}>
          <Clock className="message-queue-marker" size={10} aria-hidden="true" />
          <span className={`message-queue-time${item.missed ? " is-missed" : ""}`}>
            {item.missed ? t("later.missed", { time: scheduleTime(item.at) }) : scheduleTime(item.at)}
          </span>
          <span className="message-queue-text" title={item.prompt}>{item.prompt}</span>
          <div className="message-queue-actions">
            <button type="button" disabled={editDisabled} onClick={() => onEdit(item)} title={t("later.edit")} aria-label={t("later.edit")}>
              <Pencil size={12} />
            </button>
            <button type="button" disabled={disabled} onClick={() => onRemove(item.id)} title={t("later.remove")} aria-label={t("later.remove")}>
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function editable(item: PendingPrompt): boolean {
  return item.references.length === 0 && item.images.length === 0 && item.attachments.length === 0;
}
