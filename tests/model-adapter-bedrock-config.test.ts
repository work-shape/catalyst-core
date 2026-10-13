import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BEDROCK_TEST_ACCOUNT_ID,
  answerWith,
  bedrock,
  bedrockFactory,
  captured,
  collect,
  hello,
  message
} from "./support/bedrock-adapter";
import { RECORDED_BEDROCK_PROFILE } from "./support/model-adapter-recordings";

/** What an `aws-bedrock` entry may name: the EU, and a profile that attributes its calls. */

const ACCOUNT_ID = BEDROCK_TEST_ACCOUNT_ID;
const OTHER_ACCOUNT_ID = "999999999999";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Bedrock adapter: what a config may name", () => {
  it.each([
    ["a model id", "anthropic.claude-sonnet-5-5", "not attributed to this consumer"],
    ["a shared EU profile", "eu.anthropic.claude-sonnet-5-5", "not attributed to this consumer"],
    ["a global profile", "global.anthropic.claude-sonnet-5-5", "not attributed to this consumer"],
    [
      "a foundation model ARN",
      "arn:aws:bedrock:eu-central-1::foundation-model/anthropic.claude-sonnet-5-5",
      "not attributed to this consumer"
    ],
    [
      "a shared profile ARN",
      `arn:aws:bedrock:eu-central-1:${ACCOUNT_ID}:inference-profile/eu.anthropic.claude-sonnet-5-5`,
      "not attributed to this consumer"
    ],
    [
      "a profile in a US region",
      `arn:aws:bedrock:us-east-1:${ACCOUNT_ID}:application-inference-profile/abc123`,
      "calls go to eu-central-1 only"
    ],
    [
      "a profile in another EU region",
      `arn:aws:bedrock:eu-west-1:${ACCOUNT_ID}:application-inference-profile/abc123`,
      "calls go to eu-central-1 only"
    ],
    [
      "a profile of another AWS account",
      `arn:aws:bedrock:eu-central-1:${OTHER_ACCOUNT_ID}:application-inference-profile/recordedprofile`,
      "the profile belongs to another AWS account than the provider's 'accountId'"
    ],
    [
      "a profile with a path that leaves it",
      `arn:aws:bedrock:eu-central-1:${ACCOUNT_ID}:application-inference-profile/abc/../x`,
      "not attributed to this consumer"
    ]
  ])(
    "refuses %s as the entry's model, a binding's model and a call's model",
    async (_, model, reason) => {
      const sent = answerWith(() => Response.json(message([{ type: "text", text: "Hello." }])));
      const factory = await bedrockFactory();
      const expected = {
        code: "VALIDATION_FAILED",
        message: expect.stringContaining(reason)
      };

      // The entry's own model: creating the adapter stops startup.
      const entry = captured(() =>
        factory({ id: "bedrock", type: "aws-bedrock", region: "eu", model })
      );
      expect(entry).toMatchObject(expected);
      // The message names the reason and never the id: an ARN holds the account id.
      expect(entry instanceof Error ? entry.message : "").not.toMatch(/\d{12}/u);

      // A binding's model: startup asks the capabilities of every binding.
      const adapter = factory({
        id: "bedrock",
        type: "aws-bedrock",
        region: "eu",
        model: RECORDED_BEDROCK_PROFILE
      });
      expect(captured(() => adapter.capabilities(model))).toMatchObject(expected);

      // A call that names the model past both: nothing is sent.
      await expect(adapter.complete({ model, ...hello })).rejects.toMatchObject(expected);
      await expect(collect(adapter.stream({ model, ...hello }))).rejects.toMatchObject(expected);
      expect(sent).toHaveLength(0);
    }
  );

  it("refuses an entry outside the EU, and has no setting for another host", async () => {
    const factory = await bedrockFactory();
    expect(
      captured(() =>
        factory({
          id: "bedrock",
          type: "aws-bedrock",
          region: "global",
          model: RECORDED_BEDROCK_PROFILE
        })
      )
    ).toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "'infrastructure.models.bedrock.region' must be 'eu': the 'aws-bedrock' provider calls Bedrock in eu-central-1 and nowhere else"
    });

    for (const setting of ["baseUrl", "endpoint", "awsRegion"]) {
      await expect(
        bedrockFactory({ [setting]: "https://bedrock-runtime.us-east-1.amazonaws.com" })
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          `'infrastructure.models.bedrock.${setting}' is not a setting of the 'aws-bedrock' provider`
        )
      });
    }
    await expect(bedrockFactory({ region: undefined })).rejects.toMatchObject({
      message: expect.stringContaining("is required and must be one of eu, global")
    });
  });

  it("declares tool calls, images, documents, answer formats and thinking, and nothing it does not map", async () => {
    const adapter = await bedrock();
    expect(adapter.capabilities(RECORDED_BEDROCK_PROFILE)).toEqual({
      reasoningEfforts: ["none", "low", "medium", "high"],
      nativeTools: [],
      toolCalls: true,
      serverCompaction: false,
      // Carries the thinking of a run's tool-use turns to the run's next request.
      continuation: true,
      fastTier: false,
      imageInput: true,
      documentInput: true,
      structuredOutput: true,
      streaming: true,
      priceRequired: true
    });
  });

  it("needs the account id of the instance, and takes nothing but twelve digits", async () => {
    await expect(bedrockFactory({ accountId: undefined })).rejects.toMatchObject({
      message: expect.stringContaining("'infrastructure.models.bedrock.accountId'")
    });
    for (const accountId of ["12345678901", "1234567890123", "account-one", 123456789012]) {
      await expect(bedrockFactory({ accountId })).rejects.toMatchObject({
        message: expect.stringContaining("'infrastructure.models.bedrock.accountId'")
      });
    }
    // The same profile is taken by the entry of its account and refused by another's.
    const factory = await bedrockFactory({ accountId: OTHER_ACCOUNT_ID });
    expect(
      captured(() =>
        factory({
          id: "bedrock",
          type: "aws-bedrock",
          region: "eu",
          model: RECORDED_BEDROCK_PROFILE
        })
      )
    ).toMatchObject({ message: expect.stringContaining("another AWS account") });
  });
});
