// `when`: the small expression language that decides where a plugin's
// entries show. The host evaluates it; plugins never run code to decide
// visibility. It has `==`, `!=`, `&&`, `||`, `!`, parentheses, single- or
// double-quoted strings, numbers, `true` and `false`, and these names:
//
//   project.type  project.plugin('<id>')  panel.focused  selection.kind
//   selection.count  preview.status  platform
//
// A name with no value (no project open, nothing selected) is undefined,
// which is false and equals nothing but another undefined.

export const WHEN_NAMES = [
  "project.type",
  "panel.focused",
  "selection.kind",
  "selection.count",
  "preview.status",
  "platform",
] as const;

export type WhenName = (typeof WHEN_NAMES)[number];

export interface WhenContext {
  values: Partial<Record<WhenName, string | number | boolean>>;
  /** The plugins active in the open project. */
  plugins?: ReadonlySet<string>;
}

type Value = string | number | boolean | undefined;
type Node = (context: WhenContext) => Value;

export type CompiledWhen =
  | { ok: true; evaluate(context: WhenContext): boolean }
  | { ok: false; error: string };

/** Longer expressions are refused; the manifest caps them at 300 characters. */
const WHEN_MAX_CHARS = 300;
/** Nesting deeper than this is refused, so evaluation never runs deep. */
const WHEN_MAX_DEPTH = 20;

const TOKEN =
  /\s*(?:(\|\||&&|==|!=|!|\(|\))|'([^'\\]*)'|"([^"\\]*)"|(-?\d+(?:\.\d+)?)|([A-Za-z][A-Za-z.]*))/y;

type Token =
  | { kind: "op"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "name"; value: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    if (!text.slice(TOKEN.lastIndex).trim()) break;
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(text);
    if (!match) throw new Error(`unexpected text at ${at + 1}`);
    if (match[1]) tokens.push({ kind: "op", value: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: "string", value: match[2] });
    else if (match[3] !== undefined) tokens.push({ kind: "string", value: match[3] });
    else if (match[4]) tokens.push({ kind: "number", value: Number(match[4]) });
    else tokens.push({ kind: "name", value: match[5]! });
  }
  return tokens;
}

export function compileWhen(text: string): CompiledWhen {
  try {
    if (text.length > WHEN_MAX_CHARS)
      throw new Error(`longer than ${WHEN_MAX_CHARS} characters`);
    const tokens = tokenize(text);
    let index = 0;
    const peek = () => tokens[index];
    const isOp = (value: string) => {
      const token = peek();
      return token?.kind === "op" && token.value === value;
    };
    const expect = (value: string) => {
      if (!isOp(value)) throw new Error(`expected ${value}`);
      index++;
    };
    const or = (depth: number): Node => {
      if (depth > WHEN_MAX_DEPTH) throw new Error("nested too deeply");
      let left = and(depth);
      while (isOp("||")) {
        index++;
        const a = left;
        const b = and(depth);
        left = (context) => Boolean(a(context)) || Boolean(b(context));
      }
      return left;
    };
    const and = (depth: number): Node => {
      let left = not(depth);
      while (isOp("&&")) {
        index++;
        const a = left;
        const b = not(depth);
        left = (context) => Boolean(a(context)) && Boolean(b(context));
      }
      return left;
    };
    const not = (depth: number): Node => {
      if (isOp("!")) {
        index++;
        if (depth + 1 > WHEN_MAX_DEPTH) throw new Error("nested too deeply");
        const operand = not(depth + 1);
        return (context) => !operand(context);
      }
      return compare(depth);
    };
    const compare = (depth: number): Node => {
      const left = primary(depth);
      for (const op of ["==", "!="])
        if (isOp(op)) {
          index++;
          const right = primary(depth);
          return op === "=="
            ? (context) => left(context) === right(context)
            : (context) => left(context) !== right(context);
        }
      return left;
    };
    const primary = (depth: number): Node => {
      const token = peek();
      if (!token) throw new Error("ends too soon");
      index++;
      if (token.kind === "op") {
        if (token.value !== "(") throw new Error(`unexpected ${token.value}`);
        const inner = or(depth + 1);
        expect(")");
        return inner;
      }
      if (token.kind === "string" || token.kind === "number") {
        const value = token.value;
        return () => value;
      }
      if (token.value === "true") return () => true;
      if (token.value === "false") return () => false;
      if (token.value === "project.plugin") {
        expect("(");
        const id = peek();
        if (id?.kind !== "string") throw new Error("project.plugin takes a plugin id");
        index++;
        expect(")");
        return (context) => context.plugins?.has(id.value) ?? false;
      }
      if (!(WHEN_NAMES as readonly string[]).includes(token.value))
        throw new Error(`unknown name ${token.value}`);
      const name = token.value as WhenName;
      return (context) => context.values[name];
    };
    const root = or(0);
    if (index < tokens.length) throw new Error("has extra text at the end");
    return { ok: true, evaluate: (context) => Boolean(root(context)) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Evaluates an entry's `when`; an entry without one always shows, and one that doesn't compile never does. */
export function matchesWhen(when: string | undefined, context: WhenContext): boolean {
  if (when === undefined) return true;
  const compiled = compileWhen(when);
  return compiled.ok && compiled.evaluate(context);
}
