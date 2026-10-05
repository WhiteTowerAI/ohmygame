import { useEffect, useId, useRef, useState } from "react";

export function ProjectRenameDialog({ name, returnFocus, onClose, onConfirm }: {
  name: string;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const composing = useRef(false);
  const submitted = useRef(false);
  const [draft, setDraft] = useState(name);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    nameInput.current?.focus();
    nameInput.current?.select();
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.isComposing || composing.current || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button, input")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => {
      window.removeEventListener("keydown", handleKeyboard);
      previousFocus?.focus();
    };
  }, [returnFocus]);

  return (
    <div className="project-create-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialog} className="project-create-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header><h2 id={titleId}>Rename project</h2></header>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (composing.current || submitted.current) return;
          submitted.current = true;
          onConfirm(draft);
        }}>
          <label className="project-create-name">
            <span>Name</span>
            <input ref={nameInput} value={draft} onChange={(event) => setDraft(event.target.value)}
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={() => { composing.current = false; }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
              }} />
          </label>
          <footer>
            <button type="button" onClick={onClose}>Cancel</button>
            <button className="project-create-submit" type="submit">Save</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
