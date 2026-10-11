import { ApiError } from "@vivd-catalyst/api-client";
import type {
  ConnectionDetail,
  ConnectionsClient,
  ConnectionTestResult
} from "./connections-client";

// The instance does not answer `connections.get`, `connections.test` and
// `connections.list_tools` yet. Until it does, this stands where `client.connections` will
// stand. It invents nothing: it answers what a browser test planted on the window, and
// without a planted answer it refuses, so the page of a real Connection says that its status
// could not be read. This file leaves with the commit that binds the page to the instance.

/** What a refused call answers with, by the error code a test names. */
const REFUSAL_STATUS = { FORBIDDEN: 403, NOT_FOUND: 404, INTERNAL: 500 } as const;
type PlantedRefusal = keyof typeof REFUSAL_STATUS;

/** The answers a browser test plants: per call a result or the code it is refused with. */
export interface PlantedConnectionAnswers {
  detail?: ConnectionDetail | PlantedRefusal;
  /** What `detail` answers after a test ran, as the instance records what the test found. */
  detailAfterTest?: ConnectionDetail;
  test?: ConnectionTestResult | PlantedRefusal;
  /** How long the test takes, so a test can look at the running state. */
  testDelayMs?: number;
}

declare global {
  interface Window {
    /** Set by a browser test. The product never sets it. */
    catalystPlantedConnections?: PlantedConnectionAnswers;
  }
}

function refusal(code: PlantedRefusal, message = `Planted refusal ${code}`): ApiError {
  return new ApiError(REFUSAL_STATUS[code], message, { error: { code, message } });
}

function planted(): PlantedConnectionAnswers {
  return (typeof window === "undefined" ? undefined : window.catalystPlantedConnections) ?? {};
}

export const plantedConnectionsClient: ConnectionsClient = {
  get() {
    const { detail } = planted();
    if (detail === undefined) {
      return Promise.reject(
        refusal("NOT_FOUND", "This release does not report the status of a connection yet.")
      );
    }
    return typeof detail === "string" ? Promise.reject(refusal(detail)) : Promise.resolve(detail);
  },
  async test() {
    const answers = planted();
    if (answers.test === undefined) {
      throw refusal("NOT_FOUND");
    }
    await new Promise((resolve) => window.setTimeout(resolve, answers.testDelayMs ?? 0));
    if (typeof answers.test === "string") {
      throw refusal(answers.test);
    }
    if (answers.detailAfterTest) {
      window.catalystPlantedConnections = { ...answers, detail: answers.detailAfterTest };
    }
    return answers.test;
  },
  list_tools: () => Promise.resolve({ connections: [] })
};
