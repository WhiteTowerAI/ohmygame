import { useEffect, useId, useRef, useState } from "react";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";

export interface VideoMentionOption {
  alias: string;
  name: string;
  assetId?: string;
}

/** Plain text aliases stay editable; their stable asset bindings live on the video node. */
export function VideoReferencePrompt({ value, disabled, options, onChange }: {
  value: string;
  disabled?: boolean;
  options: VideoMentionOption[];
  onChange(value: string): void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const composing = useRef(false);
  useEffect(() => { if (disabled) editing.current = false; if (!editing.current && !composing.current) setDraft(value); }, [value, disabled]);
  const listId = useId();
  const [query, setQuery] = useState<{ start: number; end: number; text: string }>();
  const [active, setActive] = useState(0);
  const candidates = options.filter((option) => !query?.text || `${option.alias} ${option.name}`.toLowerCase().includes(query.text.toLowerCase()));
  const open = !disabled && query !== undefined;
  function inspect() {
    const element = input.current;
    if (!element || element.selectionStart !== element.selectionEnd) { setQuery(undefined); return; }
    const end = element.selectionStart;
    const match = /(?:^|\s|[，。；：、（(])@([^@\s]*)$/.exec(element.value.slice(0, end));
    setQuery(match ? { start: end - match[1]!.length - 1, end, text: match[1]! } : undefined);
    setActive(0);
  }
  function insert(option: VideoMentionOption) {
    if (!query || !input.current) return;
    const current = input.current.value;
    const text = `@${option.alias} `;
    const next = current.slice(0, query.start) + text + current.slice(query.end);
    const cursor = query.start + text.length;
    setDraft(next);
    onChange(next);
    setQuery(undefined);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(cursor, cursor); });
  }
  return <div className="video-reference-prompt">
    <textarea ref={input} aria-label="Video prompt" rows={3} value={draft} disabled={disabled}
      placeholder="Describe the video. Type @ to reference an image."
      aria-autocomplete="list" aria-controls={open ? listId : undefined}
      aria-activedescendant={open && candidates[active] ? `${listId}-${active}` : undefined}
      onFocus={() => { editing.current = true; }}
      onChange={(event) => {
        const text = event.currentTarget.value;
        setDraft(text);
        if (!composing.current && !(event.nativeEvent as InputEvent).isComposing) { onChange(text); inspect(); }
      }} onSelect={() => { if (!composing.current) inspect(); }}
      onCompositionStart={() => { composing.current = true; setQuery(undefined); }}
      onCompositionEnd={(event) => { composing.current = false; setDraft(event.currentTarget.value); onChange(event.currentTarget.value); inspect(); }}
      onBlur={() => { editing.current = false; if (composing.current) { composing.current = false; onChange(input.current?.value ?? draft); } setQuery(undefined); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || !open) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setQuery(undefined); }
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && candidates.length) {
          event.preventDefault(); event.stopPropagation();
          setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length);
        }
        if ((event.key === "Enter" || event.key === "Tab") && candidates[active]) {
          event.preventDefault(); event.stopPropagation(); insert(candidates[active]!);
        }
      }} />
    {open ? <div className="video-mention-menu nowheel" role="listbox" id={listId} aria-label="Reference images">
      {candidates.length ? candidates.map((option, index) => <button key={option.alias} id={`${listId}-${index}`}
        type="button" role="option" aria-selected={index === active} className={index === active ? "is-active" : ""}
        onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()}
        onClick={() => insert(option)} onPointerMove={() => setActive(index)}>
        <MentionThumbnail assetId={option.assetId} />
        <span><strong>@{option.alias}</strong><small>{option.name}</small></span>
      </button>) : <p>{options.length ? "No matching images" : "Add or connect an image first"}</p>}
    </div> : null}
  </div>;
}

function MentionThumbnail({ assetId }: { assetId?: string }) {
  const preview = useWorkspaceAssetUrl(undefined, "", 0, assetId);
  return preview.url ? <img src={preview.url} alt="" /> : <span className="video-mention-placeholder" />;
}
