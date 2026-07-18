import { ExperienceRuntime } from "./experiences/runtime";
import type { ExperienceRuntimeDependencies } from "./experiences/runtime";

const factory = {
  create(input: ExperienceRuntimeDependencies): ExperienceRuntime {
    return new ExperienceRuntime(input);
  },
};

if (typeof window !== "undefined") {
  Object.defineProperty(window, "__wtsWebExperiencesFactory", {
    value: factory,
    writable: false,
    configurable: false,
  });
}

export default factory;
