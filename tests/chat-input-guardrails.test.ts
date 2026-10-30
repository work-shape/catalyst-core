import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  CHAT_INPUT_EVENT,
  type BeforeActionInput
} from "@work-shape/catalyst-core";
import {
  CHAT_INPUT_FLOOR_GUARDRAILS,
  compileGuardrailPattern,
  GUARDRAIL_CHECKED_FIELD_MAX_CHARS,
  parseClientInstanceConfig,
  passesLuhn,
  releaseGuardrailFloor
} from "@work-shape/catalyst-config-schema";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance } from "./support/test-instance";
import { judgeBinding, runnerOf } from "./support/guardrails";
import { withTestSql } from "./support/test-sql";

// The guardrails on a person's chat message (GR-4): the default rules of the operator's floor,
// patterns only, a Luhn check for card numbers, bounded time, and hits that keep the rule, the
// message id, the field and a count, never text. Spec: events-workflows-and-guardrails.md,
// Guardrails on chat, acceptance checks 59 to 61.

const instance = asClientInstanceId("chat-input-guardrails");
const context = { correlationId: "corr_chat_input" };
const CARD = "4111 1111 1111 1111";
const CARD_WRONG_CHECKSUM = "4111 1111 1111 1112";
const IBAN = "DE89 3704 0044 0532 0130 00";
/** A German tax id (Steuer-ID) and a tax number (Steuernummer). */
const TAX_ID = "65 929 970 489";
const TAX_NUMBER = "21/815/08150";
const GITHUB_TOKEN = `ghp_${"a1B2c3D4e5".repeat(4)}`;

const cardPattern = CHAT_INPUT_FLOOR_GUARDRAILS["chat-card-numbers"].check;

function message(text: string, attachments?: string): BeforeActionInput {
  return {
    event: CHAT_INPUT_EVENT,
    subject: { kind: "message", id: "msg_checked" },
    match: { agent: "assistant" },
    fields: () => ({ text, ...(attachments === undefined ? {} : { attachments }) })
  };
}

async function floor(guardrails: Record<string, unknown> = {}) {
  const { stores } = await createTestInstance();
  return { stores, ...runnerOf(stores, instance, guardrails) };
}

describe("the Luhn check of a card number", () => {
  const pattern = compileGuardrailPattern(cardPattern.pattern, cardPattern.checksum);

  // Fails without the change: a run of 16 digits matched whether or not it was a card.
  it("counts a number that passes it, and no IBAN, tax id or number that fails it", () => {
    expect(passesLuhn("4111111111111111")).toBe(true);
    expect(passesLuhn("4111111111111112")).toBe(false);
    expect(pattern.test(`Karte ${CARD} bis 12/27`)).toBe(true);
    expect(pattern.test("Karte 4111-1111-1111-1111.")).toBe(true);
    expect(pattern.test(`Karte ${CARD_WRONG_CHECKSUM}`)).toBe(false);
    expect(pattern.test(`IBAN ${IBAN}`)).toBe(false);
    expect(pattern.test(`IBAN ${IBAN.replaceAll(" ", "")}`)).toBe(false);
    expect(pattern.test(`Steuer-ID ${TAX_ID}, Steuernummer ${TAX_NUMBER}`)).toBe(false);
    // A card number inside a longer run of digit groups is part of something else.
    expect(pattern.test(`Ref 12 ${CARD}`)).toBe(false);
    expect(pattern.count(`${CARD} und ${CARD}`, 100)).toBe(2);
  });
});

describe("the default rules on chat input", () => {
  // Fails without the change: release config had no rules on chat input.
  it("are on by default, can be switched off one by one, and give way to an operator's rule", () => {
    const floorOf = (config: Record<string, unknown>) =>
      releaseGuardrailFloor(parseClientInstanceConfig({ ...createTestConfig(), ...config }));
    expect(Object.keys(floorOf({})).sort()).toEqual([
      "chat-card-numbers",
      "chat-passwords",
      "chat-secrets",
      "chat-special-categories"
    ]);
    expect(
      Object.keys(floorOf({ chatInputGuardrails: { "chat-special-categories": false } }))
    ).not.toContain("chat-special-categories");
    const own = {
      on: CHAT_INPUT_EVENT,
      check: { kind: "pattern", pattern: "geheim" },
      outcome: "warn"
    };
    expect(floorOf({ guardrails: { "chat-secrets": own } })["chat-secrets"]).toEqual(own);
    // What the operator wrote stays as written: the defaults join only where the floor is read.
    expect(parseClientInstanceConfig(createTestConfig()).guardrails).toEqual({});
  });

  it("have no rule on an IBAN or a tax id", () => {
    const patterns = Object.values(CHAT_INPUT_FLOOR_GUARDRAILS).map((rule) =>
      compileGuardrailPattern(rule.check.pattern, "checksum" in rule.check ? "luhn" : undefined)
    );
    for (const text of [IBAN, TAX_ID, TAX_NUMBER, `Mein Konto: ${IBAN}`]) {
      expect(
        patterns.some((pattern) => pattern.test(text)),
        text
      ).toBe(false);
    }
  });

  it.each([
    ["model_judge", { kind: "model_judge", modelBindingId: "guardrailCheck", instruction: "x" }],
    ["code", { kind: "code", module: "./check.js" }]
  ])("refuse a %s check at load", (_kind, check) => {
    expect(() =>
      parseClientInstanceConfig({
        ...createTestConfig({ modelBindings: [judgeBinding] }),
        guardrails: { chat_judge: { on: CHAT_INPUT_EVENT, check, outcome: "warn" } }
      })
    ).toThrow("Client instance config is invalid");
  });

  it("refuse require_approval at load", () => {
    expect(() =>
      parseClientInstanceConfig({
        ...createTestConfig(),
        guardrails: {
          chat_hold: {
            on: CHAT_INPUT_EVENT,
            check: { kind: "pattern", pattern: "x" },
            outcome: "require_approval"
          }
        }
      })
    ).toThrow("Client instance config is invalid");
  });
});

describe("the guardrails at message.before_send", () => {
  // Fails without the change: no guardrail ran on a person's message.
  it.each([
    ["a secret", `Hier der Token: ${GITHUB_TOKEN}`, "chat-secrets", "block"],
    ["a private key", "-----BEGIN OPENSSH PRIVATE KEY-----", "chat-secrets", "block"],
    ["a password", "Passwort: Sommer2026!", "chat-passwords", "warn"],
    ["a card number", `Zahle mit ${CARD}`, "chat-card-numbers", "block"],
    [
      "a special category",
      "Ich bin seit Montag krankgeschrieben",
      "chat-special-categories",
      "warn"
    ]
  ])("answer %s", async (_case, text, guardrailName, outcome) => {
    const f = await floor();
    const answers = await f.runner.answer(message(text), context);
    expect(answers.filter((answer) => answer.outcome !== "allow")).toEqual([
      expect.objectContaining({ guardrailName, outcome, field: "text", matchCount: 1 })
    ]);
  });

  it("allow a message with an IBAN, a tax id or a card number that fails the Luhn check", async () => {
    const f = await floor();
    const answers = await f.runner.answer(
      message(`Konto ${IBAN}, Steuer-ID ${TAX_ID}, Karte ${CARD_WRONG_CHECKSUM}`),
      context
    );
    expect(answers.map((answer) => answer.outcome)).toEqual(["allow", "allow", "allow", "allow"]);
  });

  it("check the text of the attachments as their own field", async () => {
    const f = await floor();
    const answers = await f.runner.answer(message("Siehe Anhang.", `Karte ${CARD}`), context);
    expect(answers.find((answer) => answer.guardrailName === "chat-card-numbers")).toMatchObject({
      outcome: "block",
      field: "attachments",
      matchCount: 1
    });
  });

  // Fails without the change: a field longer than the pattern reads at once went unread, and a
  // key at the end of a long message passed the rule that blocks it.
  it("read a long message in overlapping pieces, so a key anywhere in it is blocked", async () => {
    const f = await floor();
    // The secrets rule is the largest program, so it reads the fewest characters at once.
    const secrets = CHAT_INPUT_FLOOR_GUARDRAILS["chat-secrets"].check.pattern;
    const { maxChars } = compileGuardrailPattern(secrets);
    const filler = (chars: number) => "a ".repeat(Math.ceil(chars / 2)).slice(0, chars);
    // About 100 KB with the key at the end.
    const long = `${filler(100_000)} ${GITHUB_TOKEN}`;
    expect(long.length).toBeGreaterThan(maxChars);
    const answers = await f.runner.answer(message(long), context);
    expect(answers.find((answer) => answer.guardrailName === "chat-secrets")).toMatchObject({
      outcome: "block",
      field: "text",
      matchCount: 1
    });
    // A key across the border of two pieces is found whole, and counted once.
    const own = maxChars - 2 * 4096;
    const across = `${filler(own - 10)} ${GITHUB_TOKEN} ${filler(own)} ${GITHUB_TOKEN}`;
    const pattern = compileGuardrailPattern(secrets);
    expect(pattern.count(across, 10)).toBe(2);
    expect(pattern.count(`${filler(3 * maxChars)} ${GITHUB_TOKEN}`, 10)).toBe(1);
    expect(pattern.test(`${filler(3 * maxChars)} ${GITHUB_TOKEN}`)).toBe(true);
    // A card number read in pieces keeps its Luhn check and the digits around it.
    const card = compileGuardrailPattern(cardPattern.pattern, cardPattern.checksum);
    expect(card.count(`${filler(card.maxChars)} ${CARD}`, 10)).toBe(1);
    // Digits that start a piece's own part, after more digits before it, are no card number.
    const ownCard = card.maxChars - 2 * 4096;
    const atBorder = `${filler(ownCard - 6)}12345 ${CARD.replaceAll(" ", "")} ${filler(card.maxChars)}`;
    expect(atBorder.indexOf("4111")).toBe(ownCard);
    expect(card.count(atBorder, 10)).toBe(0);
  });

  it("say what they could not read, and block it only where a rule blocks", async () => {
    const f = await floor();
    const tooLong = "a ".repeat(GUARDRAIL_CHECKED_FIELD_MAX_CHARS / 2 + 1);
    const answers = await f.runner.answer(message(tooLong), context);
    expect(answers.find((answer) => answer.guardrailName === "chat-passwords")).toMatchObject({
      outcome: "allow",
      notChecked: ["text"]
    });
    expect(answers.find((answer) => answer.guardrailName === "chat-secrets")).toMatchObject({
      outcome: "block",
      field: "text",
      notChecked: ["text"]
    });
  });

  // Patterns run as RE2: no input makes them backtrack.
  it("answer in bounded time on input made to make a backtracking pattern slow", async () => {
    const f = await floor();
    const attacks = [
      `${"a".repeat(60_000)}!`,
      `${"1 ".repeat(30_000)}x`,
      `password${" ".repeat(60_000)}`,
      `eyJ${"a".repeat(30_000)}.eyJ${"a".repeat(30_000)}`,
      // The most a message can carry, read in pieces by every rule.
      `${"Passwort a1 ".repeat(90_000)}`
    ];
    const started = performance.now();
    for (const text of attacks) await f.runner.answer(message(text), context);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  // Fails without the change: a hit could name no field and counted nothing.
  it("keep the rule, the message id, the field and a count, never the text, and list none", async () => {
    const f = await floor();
    await f.runner.answer(message(`Karten: ${CARD} und ${CARD}`), context);
    const rows = await withTestSql(
      (sql) =>
        sql`SELECT * FROM guardrail_hits WHERE client_instance_id = ${instance} AND guardrail_name = 'chat-card-numbers'`
    );
    expect(rows).toEqual([
      expect.objectContaining({
        event: CHAT_INPUT_EVENT,
        outcome: "block",
        subject_kind: "message",
        subject_id: "msg_checked",
        field: "text",
        match_count: 2
      })
    ]);
    expect(JSON.stringify(rows)).not.toContain("4111");
    // Hits on chat messages are counted by rule, never listed.
    expect(
      await f.stores.guardrails.listHits({
        clientInstanceId: instance,
        guardrailName: "chat-card-numbers",
        limit: 10
      })
    ).toEqual([]);
    expect(
      await f.stores.guardrails.countHits({
        clientInstanceId: instance,
        guardrailName: "chat-card-numbers"
      })
    ).toMatchObject({ last7Days: 1, last30Days: 1 });
  });
});
