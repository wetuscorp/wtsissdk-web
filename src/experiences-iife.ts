import { ExperienceRuntime } from "./experiences/runtime";
import type { ExperienceRuntimeDependencies } from "./experiences/runtime";

const factory = {
  create(input: ExperienceRuntimeDependencies): ExperienceRuntime {
    return new ExperienceRuntime(input);
  },
};

if (typeof window !== "undefined") {
  const host = window as Window & {
    __wtsWebExperiencesLoadProof?: object;
    __wtsWebExperiencesFactoryProof?: object;
  };
  const loadProof = host.__wtsWebExperiencesLoadProof;
  Object.defineProperty(host, "__wtsWebExperiencesFactory", {
    value: factory,
    writable: false,
    configurable: false,
  });
  if (loadProof) {
    Object.defineProperty(host, "__wtsWebExperiencesFactoryProof", {
      value: loadProof,
      writable: false,
      configurable: true,
    });
  }
}

export default factory;
