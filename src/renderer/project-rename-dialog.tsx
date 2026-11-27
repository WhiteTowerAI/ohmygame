import { useId, useRef, useState } from "react";
import { t } from "./i18n.js";
import { Button, Dialog, Input } from "./ui/index.js";

export function ProjectRenameDialog({ name, title = t("projects.rename"), onClose, onConfirm }: {
  name: string;
  title?: string;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const formId = useId();
  // Enter that ends an input method's composition picks a word; it doesn't save.
  const composing = useRef(false);
  const submitted = useRef(false);
  const [draft, setDraft] = useState(name);
  return (
    <Dialog open size="sm" title={title} onClose={onClose} footer={<>
      <Button onClick={onClose}>{t("common.cancel")}</Button>
      <Button variant="primary" type="submit" form={formId}>{t("common.save")}</Button>
    </>}>
      <form id={formId} onSubmit={(event) => {
        event.preventDefault();
        if (composing.current || submitted.current) return;
        submitted.current = true;
        onConfirm(draft);
      }}>
        <Input aria-label={t("common.name")} autoFocus value={draft} onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
          }} />
      </form>
    </Dialog>
  );
}
