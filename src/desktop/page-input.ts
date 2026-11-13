/** Shared page targeting and keyboard input for game playtests and the Browser panel. */
export function keyboardEvent(key: string): {
  key: string;
  code: string;
  text?: string;
} {
  if (!key || key.length > 40) throw new Error("Invalid playtest key");
  const aliases: Record<string, string> = {
    " ": "Space",
    Escape: "Escape",
    Enter: "Enter",
    Tab: "Tab",
  };
  return {
    key,
    code: aliases[key] ?? key,
    ...(key.length === 1 ? { text: key } : {}),
  };
}

export async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted)
    throw new DOMException("Game use request aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    const onAbort = () =>
      done(new DOMException("Game use request aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    function done(error?: Error) {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
  });
}

export const TARGET_HELPERS = String.raw`
const INTERACTIVE = "button, a, input, textarea, select, [role], [data-testid], [onclick], [tabindex]:not([tabindex=\"-1\"])";
const deepQueryAll = (selector) => {
  const found = [];
  const visit = (root) => {
    found.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll("*")) if (element.shadowRoot) visit(element.shadowRoot);
  };
  visit(document);
  return found;
};
const roleFor = (element) => element.getAttribute("role") || ({
  A: "link", BUTTON: "button", INPUT: element.type === "checkbox" ? "checkbox" : element.type === "radio" ? "radio" : "textbox",
  SELECT: "combobox", TEXTAREA: "textbox",
}[element.tagName] || "");
const nameFor = (element) => element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("title") || element.innerText || (element.type === "password" ? "" : element.value) || "";
const isVisible = (element) => {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && (!element.checkVisibility || element.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
};
const matches = (element, target) => {
  if (target.testId) return element.getAttribute("data-testid") === target.testId;
  if (target.text) return (element.innerText || element.textContent || "").trim().includes(target.text);
  if (target.role) return roleFor(element) === target.role && (!target.name || nameFor(element).trim().includes(target.name));
  return false;
};
const findTarget = (target) => {
  if (target.selector) { try { return deepQueryAll(target.selector).find(isVisible) || deepQueryAll(target.selector)[0] || null; } catch { return null; } }
  const candidates = deepQueryAll(INTERACTIVE + ", canvas").filter((element) => matches(element, target));
  return candidates.find(isVisible) || candidates[0] || null;
};
const clean = (value, limit = 300) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
const listElements = () => deepQueryAll(INTERACTIVE)
  .filter(isVisible)
  .slice(0, 100)
  .map((element, index) => {
    const box = element.getBoundingClientRect();
    const role = roleFor(element);
    const name = clean(nameFor(element));
    const text = clean(element.innerText || element.textContent);
    const testId = element.getAttribute("data-testid") || "";
    return {
      index,
      tag: element.tagName.toLowerCase(),
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(text ? { text } : {}),
      ...(testId ? { testId } : {}),
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
    };
  });
const visibleText = () => {
  const parts = [];
  const visit = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.shadowRoot) visit(node.shadowRoot);
        continue;
      }
      const parent = node.parentElement;
      const value = clean(node.textContent, 1000);
      if (value && parent && !["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(parent.tagName) && isVisible(parent)) parts.push(value);
    }
  };
  if (document.body) visit(document.body);
  return clean(parts.join(" "), 4000);
};`;

export const TARGET_POINT_SCRIPT = `(target) => { ${TARGET_HELPERS}
  const element = findTarget(target);
  if (!element) return null;
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}`;

export const FOCUS_TARGET_SCRIPT = `(target) => { ${TARGET_HELPERS}
  const element = findTarget(target);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element?.isContentEditable)) return false;
  if (element.matches(":disabled") || element.readOnly || !isVisible(element)) return false;
  element.focus();
  if (element.getRootNode().activeElement !== element) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.select();
  return true;
}`;
