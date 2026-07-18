import type { ExperienceRuntime, ExperienceRuntimeDependencies } from "./runtime";

/**
 * Keeps the Experiences implementation out of the analytics entry chunk until
 * an application explicitly enables the product surface.
 */
export async function loadExperienceRuntime(
  input: ExperienceRuntimeDependencies,
): Promise<ExperienceRuntime> {
  const { ExperienceRuntime: Runtime } = await import("./runtime");
  return new Runtime(input);
}
