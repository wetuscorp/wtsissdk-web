import { TestSessionRuntime } from "./test-session";
import type { TestSessionRuntimeInput } from "./test-session";

const factory = {
  create(input: TestSessionRuntimeInput): TestSessionRuntime {
    return new TestSessionRuntime(input);
  },
};

if (typeof window !== "undefined") {
  Object.defineProperty(window, "__wtsWebTestSessionFactory", {
    value: factory,
    writable: false,
    configurable: false,
  });
}

export default factory;
