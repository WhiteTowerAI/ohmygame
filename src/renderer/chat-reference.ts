export interface ChatReference {
  text: string;
}

export function formatChatPrompt(reference: ChatReference, prompt: string): string {
  return `[Selected text]\n${reference.text.trim()}\n\n[User prompt]\n${prompt.trim()}`;
}
