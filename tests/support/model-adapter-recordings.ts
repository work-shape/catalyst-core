import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import {
  createProvider,
  runProviderCheck,
  type ModelProviderConfig,
  type ProviderCheckResult,
  type SecretResolver
} from "@vivd-catalyst/core";
import {
  modelProviderDefinitions,
  type ModelAdapter,
  type ModelAdapterFactory
} from "@vivd-catalyst/model-provider";
import { silentTestLogger } from "./model-gateway";

/**
 * Recorded exchanges with a model provider, replayed in place of the network.
 *
 * A recording holds what the adapter must send (URL and JSON body) and what the provider
 * answers (status, headers, body or server-sent events). It holds no credential: the replay
 * hands out a made-up access token and the test checks that the adapter sends it. Project,
 * host and model names are made up, and every document and image is synthetic.
 */
export interface ModelAdapterRecording {
  exchanges: RecordedExchange[];
}

interface RecordedExchange {
  request: { url: string; body: unknown };
  response: {
    status: number;
    headers?: Record<string, string>;
    /** A JSON body. */
    body?: unknown;
    /** Server-sent events, each the `data` of one event. A string is sent as it is. */
    events?: unknown[];
    /** After its events the stream stays open until the caller stops it. */
    staysOpen?: boolean;
    /** No answer comes until the caller stops the request. */
    neverAnswers?: boolean;
  };
}

/** What the adapter sent while a recording was replayed. */
export interface ReplayedRequests {
  /** The `authorization` or `api-key` header of each request to the provider. */
  credentials: (string | null)[];
  /** How many requests reached the provider. */
  count(): number;
  /** How many answer streams the adapter cancelled before they ended. */
  cancelled(): number;
}

const RECORDINGS_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/model-adapter-recordings"
);
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** The access token the replay hands out for a signed assertion. It opens nothing. */
const REPLAY_ACCESS_TOKEN = "replay-access-token";
/** The API key the replay's secrets hold for an adapter that sends a key. It opens nothing. */
const REPLAY_API_KEY = "replay-api-key";

export function loadModelAdapterRecording(adapter: string, name: string): ModelAdapterRecording {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(RECORDINGS_DIRECTORY, adapter, `${name}.json`), "utf8")
  );
  if (!isRecording(parsed)) {
    throw new Error(`Recording '${adapter}/${name}' has no exchanges`);
  }
  return parsed;
}

/**
 * Replaces `fetch` by the recording until `vi.unstubAllGlobals()`. A request that differs from
 * the recorded one fails the call with both, so a change of the wire format shows as a diff.
 */
export function replayModelAdapterRecording(
  recording: ModelAdapterRecording,
  /** The status the token endpoint answers with. A refusal carries no token. */
  tokenStatus = 200
): ReplayedRequests {
  const credentials: (string | null)[] = [];
  let next = 0;
  let cancelled = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === GOOGLE_TOKEN_URL && tokenStatus !== 200) {
      return Response.json({ error: "invalid_grant" }, { status: tokenStatus });
    }
    if (url === GOOGLE_TOKEN_URL) {
      return Response.json({
        access_token: REPLAY_ACCESS_TOKEN,
        expires_in: 3600,
        token_type: "Bearer"
      });
    }
    const exchange = recording.exchanges[next];
    next += 1;
    if (!exchange) {
      throw new Error(`The recording has no exchange ${next}: unexpected request to ${url}`);
    }
    const headers = new Headers(init?.headers);
    credentials.push(headers.get("authorization") ?? headers.get("api-key"));
    const sent = { url, body: typeof init?.body === "string" ? parseJson(init.body) : undefined };
    if (JSON.stringify(sent) !== JSON.stringify(exchange.request)) {
      throw new RecordingMismatch(sent, exchange.request);
    }
    return answer(exchange.response, init?.signal ?? undefined, () => {
      cancelled += 1;
    });
  });
  return { credentials, count: () => next, cancelled: () => cancelled };
}

/** Thrown into the adapter when it sends something else than the recording holds. */
class RecordingMismatch extends Error {
  constructor(
    readonly sent: unknown,
    readonly recorded: unknown
  ) {
    super(
      `The adapter's request differs from the recording.\nSent: ${JSON.stringify(sent, null, 2)}\nRecorded: ${JSON.stringify(recorded, null, 2)}`
    );
    this.name = "RecordingMismatch";
  }
}

function answer(
  recorded: RecordedExchange["response"],
  signal: AbortSignal | undefined,
  onCancel: () => void
): Response | Promise<Response> {
  const stopped = (): DOMException => new DOMException("This operation was aborted", "AbortError");
  if (recorded.neverAnswers) {
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) reject(stopped());
      signal?.addEventListener("abort", () => reject(stopped()), { once: true });
    });
  }
  const headers = new Headers(recorded.headers);
  if (!recorded.events) {
    return new Response(recorded.body === undefined ? null : JSON.stringify(recorded.body), {
      status: recorded.status,
      headers
    });
  }
  const events = recorded.events;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        const data = typeof event === "string" ? event : JSON.stringify(event);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      }
      if (!recorded.staysOpen) {
        controller.close();
        return;
      }
      signal?.addEventListener("abort", () => controller.error(stopped()), { once: true });
    },
    cancel() {
      onCancel();
    }
  });
  headers.set("content-type", "text/event-stream");
  return new Response(body, { status: recorded.status, headers });
}

/** One adapter as the conformance suite runs it: its entry, created through its registration. */
export interface ConformanceAdapter {
  type: string;
  provider: ModelProviderConfig;
  /** The header value the adapter must send as its credential. */
  credential: string;
  create(): Promise<ModelAdapter>;
  /** The provider's check, as the Infrastructure page runs it. */
  check(): Promise<ProviderCheckResult>;
}

let serviceAccountKey: string | undefined;

/** A service account key made for this test run. It belongs to no account. */
export function replayServiceAccountKey(): string {
  serviceAccountKey ??= JSON.stringify({
    type: "service_account",
    client_email: "replay@recorded-project.iam.gserviceaccount.test",
    private_key_id: "replay-key",
    private_key: generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    }).privateKey
  });
  return serviceAccountKey;
}

const replaySecrets: SecretResolver = {
  async resolve(name) {
    if (name === "REPLAY_VERTEX_KEY") return replayServiceAccountKey();
    if (name === "REPLAY_MODEL_KEY") return REPLAY_API_KEY;
    throw new Error(`The replay has no secret '${name}'`);
  }
};

function conformanceAdapter(
  id: string,
  credential: string,
  entry: { provider: string; region: "eu"; model: string } & Record<string, unknown>
): ConformanceAdapter {
  const provider: ModelProviderConfig = {
    id,
    type: entry.provider,
    model: entry.model,
    region: entry.region
  };
  const factory = (): Promise<ModelAdapterFactory> =>
    createProvider(
      modelProviderDefinitions,
      "models",
      { path: `infrastructure.models.${id}`, entry },
      { secrets: replaySecrets, logger: silentTestLogger }
    );
  return {
    type: entry.provider,
    provider,
    credential,
    async create() {
      return (await factory())(provider);
    },
    async check() {
      const build = await factory();
      return runProviderCheck(async (context) => (await build.check?.(context)) ?? { ok: true });
    }
  };
}

/** Every adapter of the product that reaches a provider over the network. */
export const conformanceAdapters: ConformanceAdapter[] = [
  conformanceAdapter("recorded-openai", `Bearer ${REPLAY_API_KEY}`, {
    provider: "openai-compatible",
    region: "eu",
    model: "recorded-chat-model",
    baseUrl: "https://models.example.test/v1",
    credentialSecret: "REPLAY_MODEL_KEY"
  }),
  conformanceAdapter("recorded-vertex", `Bearer ${REPLAY_ACCESS_TOKEN}`, {
    provider: "google-vertex",
    region: "eu",
    model: "recorded-gemini-model",
    projectId: "recorded-project",
    credentialSecret: "REPLAY_VERTEX_KEY"
  })
];

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRecording(value: unknown): value is ModelAdapterRecording {
  return (
    typeof value === "object" &&
    value !== null &&
    "exchanges" in value &&
    Array.isArray(value.exchanges)
  );
}
