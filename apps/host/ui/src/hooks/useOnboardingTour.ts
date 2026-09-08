import { useCallback, useEffect, useState } from "react";
import { onSignedOut } from "../lib/auth";
import {
  consumeFirstClaimTour,
  readTourProgress,
  saveTourProgress,
  tourSteps,
  type TourStep,
} from "../lib/onboarding";

export function useOnboardingTour(navigate: (step: TourStep) => void) {
  const [step, setStep] = useState(readTourProgress);
  const [paused, setPaused] = useState(false);
  const index = step ? tourSteps.indexOf(step) : -1;

  useEffect(() => {
    consumeFirstClaimTour();
    saveTourProgress(step);
    if (step) navigate(step);
  }, [step, navigate]);

  const dismiss = useCallback(() => {
    saveTourProgress();
    setPaused(false);
    setStep(undefined);
  }, []);

  useEffect(() => onSignedOut(dismiss), [dismiss]);

  const start = useCallback(() => {
    const first = tourSteps[0];
    setPaused(false);
    setStep(first);
    if (first === step && first) navigate(first);
  }, [navigate, step]);

  const resume = useCallback(() => {
    setPaused(false);
    if (step) navigate(step);
  }, [navigate, step]);

  return {
    step,
    index,
    paused,
    pause: () => setPaused(true),
    start,
    resume,
    dismiss,
    next: () => {
      setPaused(false);
      setStep(tourSteps[index + 1]);
    },
    back: () => {
      if (index > 0) {
        setPaused(false);
        setStep(tourSteps[index - 1]);
      }
    },
  };
}
