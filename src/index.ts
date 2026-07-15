import { WtsClientImpl } from "./client";
import type { WtsClient, WtsClientOptions } from "./types";

export type {
  ConsentState,
  EventProperties,
  FlushResult,
  OperationResult,
  Revenue,
  Scalar,
  WtsClient,
  WtsClientOptions,
} from "./types";

export function createWtsClient(options: WtsClientOptions): WtsClient {
  return new WtsClientImpl(options);
}
