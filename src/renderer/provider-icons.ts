import amazonBedrock from "@lobehub/icons-static-svg/icons/bedrock-color.svg";
import antGroup from "@lobehub/icons-static-svg/icons/antgroup-color.svg";
import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg";
import azureAI from "@lobehub/icons-static-svg/icons/azureai-color.svg";
import baseten from "@lobehub/icons-static-svg/icons/baseten.svg";
import cerebras from "@lobehub/icons-static-svg/icons/cerebras-color.svg";
import cloudflare from "@lobehub/icons-static-svg/icons/cloudflare-color.svg";
import codex from "@lobehub/icons-static-svg/icons/codex-color.svg";
import deepSeek from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import fireworks from "@lobehub/icons-static-svg/icons/fireworks-color.svg";
import githubCopilot from "@lobehub/icons-static-svg/icons/githubcopilot.svg";
import google from "@lobehub/icons-static-svg/icons/google-color.svg";
import googleVertex from "@lobehub/icons-static-svg/icons/vertexai-color.svg";
import groq from "@lobehub/icons-static-svg/icons/groq.svg";
import huggingFace from "@lobehub/icons-static-svg/icons/huggingface-color.svg";
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg";
import meshy from "@lobehub/icons-static-svg/icons/meshy-color.svg";
import minimax from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import mistral from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import moonshot from "@lobehub/icons-static-svg/icons/moonshot.svg";
import nvidia from "@lobehub/icons-static-svg/icons/nvidia-color.svg";
import openAI from "@lobehub/icons-static-svg/icons/openai.svg";
import openCode from "@lobehub/icons-static-svg/icons/opencode.svg";
import openRouter from "@lobehub/icons-static-svg/icons/openrouter-color.svg";
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import together from "@lobehub/icons-static-svg/icons/together-color.svg";
import vercel from "@lobehub/icons-static-svg/icons/vercel.svg";
import xAI from "@lobehub/icons-static-svg/icons/xai.svg";
import xiaomi from "@lobehub/icons-static-svg/icons/xiaomimimo.svg";
import zai from "@lobehub/icons-static-svg/icons/zai.svg";

export interface ProviderIcon {
  src: string;
  tone: "color" | "monochrome" | "light";
}

const color = (src: string): ProviderIcon => ({ src, tone: "color" });
const monochrome = (src: string): ProviderIcon => ({ src, tone: "monochrome" });

export const PROVIDER_ICONS: Readonly<Partial<Record<string, ProviderIcon>>> = {
  "amazon-bedrock": color(amazonBedrock),
  "ant-ling": color(antGroup),
  anthropic: monochrome(anthropic),
  "azure-openai-responses": color(azureAI),
  baseten: monochrome(baseten),
  cerebras: color(cerebras),
  "cloudflare-ai-gateway": color(cloudflare),
  "cloudflare-workers-ai": color(cloudflare),
  deepseek: color(deepSeek),
  fireworks: color(fireworks),
  "github-copilot": monochrome(githubCopilot),
  google: color(google),
  "google-vertex": color(googleVertex),
  groq: monochrome(groq),
  huggingface: color(huggingFace),
  "kimi-coding": color(kimi),
  meshy: { src: meshy, tone: "light" },
  minimax: color(minimax),
  "minimax-cn": color(minimax),
  mistral: color(mistral),
  moonshotai: monochrome(moonshot),
  "moonshotai-cn": monochrome(moonshot),
  nvidia: color(nvidia),
  openai: monochrome(openAI),
  "openai-codex": color(codex),
  opencode: monochrome(openCode),
  "opencode-go": monochrome(openCode),
  openrouter: color(openRouter),
  "qwen-token-plan": color(qwen),
  "qwen-token-plan-cn": color(qwen),
  "qwen-token-plan-individual": color(qwen),
  together: color(together),
  "vercel-ai-gateway": monochrome(vercel),
  xai: monochrome(xAI),
  xiaomi: monochrome(xiaomi),
  "xiaomi-token-plan-ams": monochrome(xiaomi),
  "xiaomi-token-plan-cn": monochrome(xiaomi),
  "xiaomi-token-plan-sgp": monochrome(xiaomi),
  zai: monochrome(zai),
  "zai-coding-cn": monochrome(zai),
};
