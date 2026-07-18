import type { TestSessionRuntime, TestSessionRuntimeInput } from "./test-session";

export async function loadTestSessionRuntime(
  input: TestSessionRuntimeInput,
): Promise<TestSessionRuntime> {
  const { TestSessionRuntime: Runtime } = await import("./test-session");
  return new Runtime(input);
}
