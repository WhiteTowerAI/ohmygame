import { useEffect, useRef, useState } from "react";
import type {
  OnboardingState,
  UpdateOnboardingRequest,
} from "../shared/onboarding.js";
import { INITIAL_ONBOARDING_STATE } from "../shared/onboarding.js";
import {
  getOnboardingState,
  updateOnboardingState,
  waitForRuntime,
} from "./api.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";

export function useOnboarding(eligible: boolean) {
  const generation = useReadyRuntimeGeneration();
  const [state, setState] = useState<OnboardingState>();
  const [error, setError] = useState<string>();
  const [replaying, setReplaying] = useState(false);
  const [retry, setRetry] = useState(0);
  const revision = useRef(0);

  useEffect(() => {
    if (!eligible || replaying) return;
    const current = ++revision.current;
    let active = true;
    setError(undefined);
    void waitForRuntime()
      .then(getOnboardingState)
      .then((value) => {
        if (active && current === revision.current) setState(value);
      })
      .catch((cause) => {
        if (active && current === revision.current)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [eligible, generation, replaying, retry]);

  async function save(input: UpdateOnboardingRequest) {
    ++revision.current;
    const value = await updateOnboardingState(input);
    setState(value);
    if (value.status !== "pending") setReplaying(false);
  }

  function open() {
    ++revision.current;
    setError(undefined);
    setState({ ...INITIAL_ONBOARDING_STATE });
    setReplaying(true);
  }

  return {
    state,
    error,
    replaying,
    save,
    open,
    retry: () => setRetry((value) => value + 1),
  };
}
