import type {
  QuestionnaireInput,
  QuestionnaireQuestion,
} from "../../shared/contracts.js";
import { record } from "./driver-context.js";

/** Preserve native choices; malformed or secret requests must not turn into an empty answer. */
export function nativeQuestions(
  value: unknown,
  runtime: "codex" | "codex-async" | "claude",
): QuestionnaireInput {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4)
    throw new Error("The agent must ask between one and four questions");
  const questions: QuestionnaireQuestion[] = value.map((raw, index) => {
    const question = record(raw);
    const prompt = runtime === "codex-async" ? question?.title : question?.question;
    if (!question || typeof prompt !== "string" || !prompt.trim())
      throw new Error("The agent sent an invalid question");
    if (question.isSecret === true)
      throw new Error(
        "Secret input is not supported in OhMyGame chat. Use the service's sign-in or settings page instead.",
      );
    const id = runtime === "codex" ? question.id : String(index);
    if (typeof id !== "string" || !id.trim() || id.length > 80)
      throw new Error("Invalid question identifier");
    const rawOptions = question.options ?? [];
    if (!Array.isArray(rawOptions) || rawOptions.length > 20)
      throw new Error("Invalid question options");
    const options = rawOptions.map((rawOption) => {
      const option = record(rawOption);
      const label = runtime === "codex-async" ? rawOption : option?.label;
      if (typeof label !== "string" || !label.trim() || label.length > 2000)
        throw new Error("Invalid question option");
      return {
        value: label,
        label,
        ...(typeof option?.description === "string"
          ? { description: option.description }
          : {}),
        // A literal recommendation is evidence; order and description sentiment are not.
        ...(runtime !== "codex-async" && /\((?:recommended|推荐)\)|（推荐）/i.test(label)
          ? { recommended: true }
          : {}),
      };
    });
    if (new Set(options.map((option) => option.value)).size !== options.length)
      throw new Error("Duplicate question options");
    return {
      id,
      prompt,
      options,
      allowOther:
        runtime !== "codex" || !options.length || question.isOther === true,
      ...(runtime === "claude" && question.multiSelect === true
        ? { multiSelect: true }
        : {}),
    };
  });
  if (
    new Set(
      questions.map((question) =>
        runtime === "claude" ? question.prompt : question.id,
      ),
    ).size !== questions.length
  )
    throw new Error("Duplicate questions cannot be answered unambiguously");
  return { questions };
}
