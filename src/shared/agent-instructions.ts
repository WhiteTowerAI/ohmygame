import type { ProjectType } from "./contracts.js";

/** The longest the person's own instructions may be. */
export const USER_INSTRUCTIONS_MAX_CHARACTERS = 8000;

/** What Settings shows: the person's instructions and, for each kind of project, what OhMyGame adds. */
export interface AgentInstructionsView {
  /** The person's own instructions, added after OhMyGame's in every project. */
  custom: string;
  /** Why the saved instructions can't be read or changed, when they can't. */
  problem?: string;
  builtIn: Array<{ type: ProjectType; text: string }>;
}

/** One named part of the system prompt a conversation's model last received. */
export interface ConversationInstructionsSection {
  name: string;
  text: string;
}

/** What a conversation's agent is told. */
export type ConversationInstructions =
  | {
    /** Recorded system prompt and tool summaries, plus any current restore notice. */
    kind: "ohmygame";
    /** False before the first message, when nothing has been sent. */
    started: boolean;
    sections: ConversationInstructionsSection[];
    tools: Array<{ name: string; description: string }>;
  }
  | {
    /** A coding agent CLI: OhMyGame additions assembled from current configuration. */
    kind: "coding-agent";
    runtime: string;
    text: string;
  };
