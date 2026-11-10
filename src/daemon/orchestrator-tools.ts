import { defineTool, type ToolDefinition as PiToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ORCHESTRATOR_MAX_MESSAGE_LENGTH, type OrchestratorRoleCapability, type OrchestratorRosterEntry } from "../shared/orchestrator.js";

export interface OrchestratorToolContext {
  projectId: string;
  conversationId: string;
  roleId: string;
  capability: OrchestratorRoleCapability;
  roster(): OrchestratorRosterEntry[];
  deliver(projectId: string, conversationId: string, toRoleId: string, text: string): Promise<{ delivered: boolean; queued: boolean }>;
  completeGoal(projectId: string, conversationId: string, summary: string): Promise<void>;
}

/**
 * The tool names a conversation gets, adjusted for its team role. An advisor runs unattended
 * beside the writer, so it cannot stop to ask the person a question and wait.
 */
export function teamToolNames(names: string[], capability: OrchestratorRoleCapability | undefined): string[] {
  return capability === "advisor" ? names.filter((name) => name !== "questionnaire") : names;
}

/** The tools a role uses to work with its team. Text here goes to the model, so it stays in English. */
export function createOrchestratorTools(context: OrchestratorToolContext): PiToolDefinition[] {
  /** A teammate by id, or by name as a model may write it; ids are long slugs that are easy to misremember. */
  const named = (wanted: string) => {
    const roster = context.roster();
    const key = wanted.trim().toLowerCase();
    return roster.find((entry) => entry.id === wanted) ?? roster.find((entry) => entry.id === key || entry.name.toLowerCase() === key);
  };
  const teamIds = () => context.roster().filter((entry) => entry.id !== context.roleId).map((entry) => `${entry.id} (${entry.name})`).join(", ");
  return [
    defineTool({
      name: "list_agents",
      label: "List Team",
      description: "List the agents working on this project, what each is for, and whether each is busy.",
      parameters: Type.Object({}),
      execute: async () => {
        const roster = context.roster();
        return {
          content: [{
            type: "text" as const,
            text: roster
              .map((entry) => `- ${entry.id} (${entry.name}), ${entry.capability}, ${entry.status}${entry.id === context.roleId ? ", this is you" : ""}: ${entry.persona}`)
              .join("\n"),
          }],
          details: { roster },
        };
      },
    }),
    defineTool({
      name: "send_message_to_agent",
      label: "Message Teammate",
      description: "Send a message to another agent on this project. Use it to ask a teammate for something only their role can give, or to answer one. The message arrives as their next prompt; a busy teammate gets it when their current turn ends.",
      parameters: Type.Object({
        agent: Type.String({ minLength: 1, maxLength: 120, description: "The teammate's id from list_agents, or their exact name" }),
        message: Type.String({ minLength: 1, maxLength: ORCHESTRATOR_MAX_MESSAGE_LENGTH, description: "What to tell them, in English" }),
      }),
      execute: async (_toolCallId, input) => {
        const target = named(input.agent);
        if (!target) throw new Error(`No agent called "${input.agent}". Your teammates are: ${teamIds()}.`);
        if (target.id === context.roleId) throw new Error("That is you.");
        const result = await context.deliver(context.projectId, context.conversationId, target.id, input.message);
        return {
          content: [{ type: "text" as const, text: result.queued ? `Queued for ${target.name}, who is busy now.` : `Delivered to ${target.name}.` }],
          details: result,
        };
      },
    }),
    // Only a writer can finish the work, so only a writer can say it is finished.
    ...(context.capability === "writer"
      ? [defineTool({
        name: "mark_goal_complete",
        label: "Goal Complete",
        description: "Say the team's goal is met and end the run. Use it only when the goal is genuinely done, not to end a difficult turn.",
        parameters: Type.Object({
          summary: Type.String({ minLength: 1, maxLength: 2_000, description: "What was achieved, in English" }),
        }),
        execute: async (_toolCallId, input) => {
          await context.completeGoal(context.projectId, context.conversationId, input.summary);
          return { content: [{ type: "text" as const, text: "The run is complete. Tell the user what the team achieved, then stop." }], details: { summary: input.summary } };
        },
      })]
      : []),
  ];
}
