export type ChatLayout = "left" | "right";

const CHAT_LAYOUT_STORAGE_KEY = "ohmygame:chat-layout";

export function readChatLayout(): ChatLayout {
  return localStorage.getItem(CHAT_LAYOUT_STORAGE_KEY) === "right" ? "right" : "left";
}

export function setChatLayout(layout: ChatLayout): void {
  localStorage.setItem(CHAT_LAYOUT_STORAGE_KEY, layout);
}
