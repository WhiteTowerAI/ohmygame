export type OnboardingStep = "welcome" | "connect";
export type OnboardingStatus = "pending" | "completed" | "skipped";

export interface OnboardingState {
  version: 1;
  status: OnboardingStatus;
  step: OnboardingStep;
}

export type UpdateOnboardingRequest = Pick<OnboardingState, "status" | "step">;

export const INITIAL_ONBOARDING_STATE: OnboardingState = {
  version: 1,
  status: "pending",
  step: "welcome",
};
