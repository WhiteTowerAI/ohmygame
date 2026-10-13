export type PreviewPageSource = "editor" | "player" | "playtest" | "external";
export const PREVIEW_CLIENT_QUERY = "__ohmygame_client";
export const PREVIEW_SOURCE_QUERY = "__ohmygame_view";

export function previewPageUrl(
  value: string,
  source: PreviewPageSource,
  client: string = crypto.randomUUID(),
): string {
  const url = new URL(value);
  url.searchParams.set(PREVIEW_CLIENT_QUERY, client);
  url.searchParams.set(PREVIEW_SOURCE_QUERY, source);
  return url.href;
}

export function previewPagePath(value: string): string {
  const url = new URL(value, "http://localhost");
  url.searchParams.delete(PREVIEW_CLIENT_QUERY);
  url.searchParams.delete(PREVIEW_SOURCE_QUERY);
  url.searchParams.delete("ohmygamePlaytest");
  return `${url.pathname}${url.search}${url.hash}`;
}
