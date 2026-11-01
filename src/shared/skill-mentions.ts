/**
 * Where each `$name` of a known Skill sits in the text, `end` exclusive. A
 * token starts the text or follows a space, and ends at a space, punctuation
 * or a sentence's full stop, so `$5` and `a$b` stay text.
 */
export function skillMentionRanges(text: string, available: Iterable<string>): Array<{ start: number; end: number; name: string }> {
  const names = new Set(available);
  return [...text.matchAll(/(?<=^|\s)\$([a-zA-Z0-9][a-zA-Z0-9._-]*?)(?=$|[\s,!?;:)\]}]|\.(?:$|\s))/g)]
    .filter((match) => names.has(match[1]!))
    .map((match) => ({ start: match.index, end: match.index + match[0].length, name: match[1]! }));
}
