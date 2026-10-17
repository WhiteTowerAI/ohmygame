import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  INITIAL_ONBOARDING_STATE,
  type OnboardingState,
  type UpdateOnboardingRequest,
} from "../shared/onboarding.js";

export class OnboardingStore {
  readonly #filePath: string;
  #state: OnboardingState = { ...INITIAL_ONBOARDING_STATE };
  #initialized = false;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "onboarding.json");
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.#filePath, "utf8"));
      if (
        value?.version !== 1 ||
        !["pending", "completed", "skipped"].includes(value.status) ||
        !["welcome", "connect"].includes(value.step)
      )
        throw new Error("Invalid onboarding state");
      this.#state = { version: 1, status: value.status, step: value.step };
      this.#initialized = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  get(): OnboardingState {
    return { ...this.#state };
  }

  update(input: UpdateOnboardingRequest): Promise<OnboardingState> {
    return this.#save(input, false);
  }

  initialize(input: UpdateOnboardingRequest): Promise<OnboardingState> {
    return this.#save(input, true);
  }

  #save(
    input: UpdateOnboardingRequest,
    onlyIfNew: boolean,
  ): Promise<OnboardingState> {
    const state: OnboardingState = { version: 1, ...input };
    const write = this.#writes.then(async () => {
      if (onlyIfNew && this.#initialized) return this.get();
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, this.#filePath);
        this.#state = state;
        this.#initialized = true;
      } finally {
        await rm(temporary, { force: true });
      }
      return this.get();
    });
    this.#writes = write.catch(() => {});
    return write;
  }
}
