import { useEffect, useRef, useState } from "react";

interface SelectionState {
  text: string;
  top: number;
  left: number;
}

export function SelectedTextMenu({ root, onAdd }: { root: HTMLElement | null; onAdd: (text: string) => void }) {
  const [selection, setSelection] = useState<SelectionState>();
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root) return;
    const timeline = root.closest(".timeline");
    const clear = () => setSelection(undefined);
    const update = () => {
      const current = window.getSelection();
      if (!current || current.isCollapsed || !current.rangeCount) return;
      const range = current.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) return;
      const start = parentElement(range.startContainer)?.closest(".assistant-message");
      const end = parentElement(range.endContainer)?.closest(".assistant-message");
      if (!start || start !== end) return;
      const text = current.toString().trim();
      if (!text || text.length > 12_000) return;
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      setSelection({
        text,
        top: Math.max(6, rect.top - 34),
        left: Math.min(Math.max(56, rect.left + rect.width / 2), window.innerWidth - 56),
      });
    };
    const clearOutside = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node)) clear(); };
    root.addEventListener("mouseup", update);
    timeline?.addEventListener("scroll", clear);
    window.addEventListener("resize", clear);
    document.addEventListener("mousedown", clearOutside);
    return () => {
      root.removeEventListener("mouseup", update);
      timeline?.removeEventListener("scroll", clear);
      window.removeEventListener("resize", clear);
      document.removeEventListener("mousedown", clearOutside);
    };
  }, [root]);
  if (!selection) return null;
  return (
    <div className="selected-text-menu" ref={menu} style={{ top: selection.top, left: selection.left }} role="toolbar" aria-label="Selected text actions">
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { onAdd(selection.text); setSelection(undefined); }}>
        Add to chat
      </button>
    </div>
  );
}

function parentElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}
