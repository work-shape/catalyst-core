import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelProviderError, type ModelCallStreamEvent } from "@vivd-catalyst/model-provider";
import {
  BEDROCK_TEST_ACCOUNT_ID,
  answerWith,
  bedrockEventStream,
  bedrockGateway,
  bedrockRefusal,
  message
} from "./support/bedrock-adapter";
import { bedrockChunk, bedrockStreamException } from "./support/bedrock-event-stream";

/**
 * The Bedrock adapter behind the gateway: how often a failed call is sent, and what a log line
 * and a refusal name the model by. Every case counts the requests that left.
 */

const HOUR_MS = 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const streamStart = bedrockChunk({
  type: "message_start",
  message: { usage: { input_tokens: 8 } }
});
const streamedError = (type: string, text = "SECRET-PROVIDER-WORDS"): Uint8Array =>
  bedrockChunk({ type: "error", error: { type, message: text } });

/** The failure of a streamed call, after as much time as any retry could wait. */
async function failureOfStream(pieces: Uint8Array[]): Promise<{ sent: number; failure: unknown }> {
  vi.useFakeTimers();
  const sent = answerWith(() => bedrockEventStream(pieces));
  const { gateway, call } = await bedrockGateway();
  const failed = drain(gateway.stream(call)).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(HOUR_MS);
  return { sent: sent.length, failure: await failed };
}

describe("Bedrock adapter behind the gateway: what is sent again", () => {
  it.each([
    ["an overloaded model", streamedError("overloaded_error")],
    ["a failed model", streamedError("api_error")],
    [
      "a model that failed while it streamed",
      bedrockStreamException("modelStreamErrorException", "x")
    ],
    ["a model that failed", bedrockStreamException("modelErrorException", "x")],
    ["an unavailable service", bedrockStreamException("serviceUnavailableException", "x")],
    ["a model that timed out", bedrockStreamException("modelTimeoutException", "x")]
  ])("sends a stream that reports %s three times and then fails", async (_name, piece) => {
    const { sent, failure } = await failureOfStream([streamStart, piece]);

    expect(failure).toBeInstanceOf(ModelProviderError);
    expect(failure).toMatchObject({ retryable: true });
    expect(sent).toBe(3);
  });

  it.each([
    ["a throttled stream", "throttlingException"],
    // A model that is still loading is ready a moment later: sent again like a throttled call.
    ["a stream whose model is not ready", "modelNotReadyException"]
  ])("sends %s again within a minute and then tells the user", async (_name, type) => {
    const { sent, failure } = await failureOfStream([
      streamStart,
      bedrockStreamException(type, "x")
    ]);

    expect(failure).toMatchObject({
      code: "RATE_LIMITED",
      message: "The model is receiving too many requests. Try again in a minute."
    });
    expect(sent).toBeGreaterThan(1);
  });

  it.each([
    ["a key that is not taken", streamedError("authentication_error"), "invalid_request", 401],
    ["a missing permission", streamedError("permission_error"), "invalid_request", 403],
    ["an unpaid bill", streamedError("billing_error"), "invalid_request", 402],
    ["an invalid request", streamedError("invalid_request_error"), "invalid_request", 400],
    ["a profile that is not found", streamedError("not_found_error"), "invalid_request", 404],
    ["denied access", bedrockStreamException("accessDeniedException", "x"), "invalid_request", 403],
    [
      "a refused request",
      bedrockStreamException("validationException", "x"),
      "invalid_request",
      400
    ],
    [
      "a quota that is used up",
      bedrockStreamException("serviceQuotaExceededException", "x"),
      "invalid_request",
      400
    ],
    [
      "a profile Bedrock does not find",
      bedrockStreamException("resourceNotFoundException", "x"),
      "invalid_request",
      404
    ],
    [
      "an error type of a later release",
      streamedError("error_of_a_later_release"),
      "server_error",
      undefined
    ],
    [
      "an exception of a later release",
      bedrockStreamException("exceptionOfALaterRelease", "x"),
      "server_error",
      undefined
    ]
  ])("sends a stream that reports %s once", async (_name, piece, kind, status) => {
    const { sent, failure } = await failureOfStream([streamStart, piece]);

    expect(failure).toBeInstanceOf(ModelProviderError);
    expect(failure).toMatchObject({ kind, status, retryable: false });
    expect(sent).toBe(1);
  });

  it.each([
    ["the model's error", streamedError("invalid_request_error", "prompt is too long: 9 > 8")],
    [
      "Bedrock's exception",
      bedrockStreamException("validationException", "Input is too long for requested model.")
    ],
    ["a request that is too large", streamedError("request_too_large")]
  ])(
    "tells the user that the conversation is too long when a stream reports it by %s",
    async (_name, piece) => {
      const { sent, failure } = await failureOfStream([streamStart, piece]);

      expect(failure).toMatchObject({
        kind: "context_length_exceeded",
        retryable: false,
        message: "This conversation is too long for the model. Start a new conversation."
      });
      expect(sent).toBe(1);
    }
  );

  it("sends a call whose stream stays silent once: the idle limit bounds the whole call", async () => {
    vi.useFakeTimers();
    // Nothing arrives at all, not even the start of the answer.
    const sent = answerWith(() => bedrockEventStream([], { staysOpen: true }));
    const { gateway, call } = await bedrockGateway();
    const started = Date.now();
    let failedAfterMs: number | undefined;
    const failed = drain(gateway.stream(call)).catch((error: unknown) => {
      failedAfterMs = Date.now() - started;
      return error;
    });

    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(await failed).toMatchObject({
      code: "TIMEOUT",
      retryable: false,
      message: "Model provider stream sent no data for 10 minutes"
    });
    expect(failedAfterMs).toBe(10 * 60 * 1000);
    expect(sent).toHaveLength(1);
  });

  it("sends a throttled request again and answers with the attempt that succeeds", async () => {
    vi.useFakeTimers();
    const sent = answerWith(() =>
      sent.length < 2
        ? bedrockRefusal(429, "ThrottlingException", "Too many requests.")
        : Response.json(message([{ type: "text", text: "Hello." }]))
    );
    const { gateway, call } = await bedrockGateway();

    const answered = gateway.complete(call);
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect((await answered).text).toBe("Hello.");
    expect(sent).toHaveLength(2);
  });

  it.each([401, 402, 403, 404])("sends a request refused with status %i once", async (status) => {
    vi.useFakeTimers();
    const sent = answerWith(() => bedrockRefusal(status, "AccessDeniedException", "Refused."));
    const { gateway, call } = await bedrockGateway();

    const failed = gateway.complete(call).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(await failed).toMatchObject({ kind: "invalid_request", status, retryable: false });
    expect(sent).toHaveLength(1);
  });
});

describe("Bedrock adapter behind the gateway: redirects", () => {
  it.each(["complete", "stream"] as const)(
    "does not follow a redirect of a %s request, and does not send it again",
    async (mode) => {
      vi.useFakeTimers();
      const requested: string[] = [];
      // Answers as `fetch` does: it follows a redirect unless the request forbids it.
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        requested.push(String(input));
        const redirect = new Response(null, {
          status: 307,
          headers: { location: "https://bedrock-runtime.us-east-1.amazonaws.com/elsewhere" }
        });
        if (init?.redirect === "manual") return redirect;
        if (init?.redirect === "error") throw new TypeError("fetch failed");
        requested.push("https://bedrock-runtime.us-east-1.amazonaws.com/elsewhere");
        return Response.json(message([{ type: "text", text: "From elsewhere." }]));
      });
      const { gateway, call } = await bedrockGateway();

      const failed = (
        mode === "complete" ? gateway.complete(call) : drain(gateway.stream(call))
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(HOUR_MS);

      expect(await failed).toMatchObject({
        kind: "invalid_request",
        status: 307,
        retryable: false
      });
      expect(requested).toHaveLength(1);
      expect(requested[0]).toMatch(/^https:\/\/bedrock-runtime\.eu-central-1\.amazonaws\.com\//u);
    }
  );
});

describe("Bedrock adapter behind the gateway: what names the model", () => {
  it("names the binding, never the profile, in a refusal and in the log line of an error", async () => {
    answerWith(() => bedrockRefusal(403, "AccessDeniedException", "Denied."));
    const { gateway, call, warnings } = await bedrockGateway();

    const refused = await gateway
      .complete({ ...call, fastTier: true })
      .catch((error: unknown) => error);
    await gateway.complete(call).catch(() => undefined);

    expect(refused).toMatchObject({
      message: "Model binding 'claude' of provider 'bedrock' does not support: fast tier"
    });
    expect(warnings).toEqual([
      expect.objectContaining({ type: "model_provider.error", bindingId: "claude", status: 403 })
    ]);
    expect(JSON.stringify(warnings)).not.toMatch(/arn:aws/u);
    expect(JSON.stringify(warnings)).not.toContain(BEDROCK_TEST_ACCOUNT_ID);
  });
});

describe("Bedrock adapter behind the gateway: usage that cannot be recorded", () => {
  it("names the binding, never the profile, in the log line of a failed call that could not be settled", async () => {
    answerWith(() => bedrockRefusal(403, "AccessDeniedException", "Denied."));
    const { gateway, call, errors, governance } = await bedrockGateway();
    governance.failSettlement = new Error("The usage store is down");

    const failure = await gateway.complete(call).catch((error: unknown) => error);

    // The caller reads why the call failed, not why its usage was not recorded.
    expect(failure).toMatchObject({ kind: "invalid_request", status: 403 });
    expect(governance.settled).toBe(1);
    expect(errors).toEqual([
      expect.objectContaining({
        type: "model_usage.record_failed",
        providerId: "bedrock",
        bindingId: "claude"
      })
    ]);
    expect(errors[0]).not.toHaveProperty("model");
    expect(JSON.stringify(errors)).not.toMatch(/arn:aws/u);
    expect(JSON.stringify(errors)).not.toContain(BEDROCK_TEST_ACCOUNT_ID);
  });
});

async function drain(stream: AsyncIterable<ModelCallStreamEvent>): Promise<void> {
  for await (const _event of stream) void _event;
}
