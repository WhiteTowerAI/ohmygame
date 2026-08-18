import { CornerDownRight, Trash2 } from "lucide-react";
import type { PendingPrompt } from "../shared/contracts.js";

interface MessageQueueProps {
  items: PendingPrompt[];
  disabled: boolean;
  onRemove: (turnId: string) => void;
  onSteer: (turnId: string) => void;
}

export function MessageQueue({ items, disabled, onRemove, onSteer }: MessageQueueProps) {
  if (items.length === 0) return null;

  return (
    <div className="message-queue" aria-label="Queued messages">
      {items.map((item) => (
        <div className="message-queue-row" key={item.turnId}>
          <CornerDownRight className="message-queue-marker" size={10} aria-hidden="true" />
          <span className="message-queue-text" title={item.prompt}>
            {item.prompt || `${item.images.length} image${item.images.length === 1 ? "" : "s"}`}
          </span>
          <div className="message-queue-actions">
            <button type="button" disabled={disabled} onClick={() => onSteer(item.turnId)} title="Steer current run">
              <CornerDownRight size={12} />
              <span>Steer</span>
            </button>
            <button type="button" disabled={disabled} onClick={() => onRemove(item.turnId)} title="Remove queued message" aria-label="Remove queued message">
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
