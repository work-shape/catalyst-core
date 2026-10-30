import { z } from "zod";
import { CHAT_INPUT_EVENT } from "@work-shape/catalyst-core";
import type { ReleaseGuardrailConfig } from "./guardrail-schema";

// The default rules on a person's chat message (GR-4), part of the operator's floor. Each is a
// fixed pattern that runs inside the instance; no message goes to another service for them.
// Ordinary personal data such as an IBAN or a tax ID is not stopped: the conversation is where
// people work with it. Spec: events-workflows-and-guardrails.md, Guardrails on chat.

/** Secrets: API keys, access tokens and private keys. RE2, case as the issuers write them. */
const SECRET_PATTERNS = [
  // A private key in PEM or OpenSSH form.
  String.raw`-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----`,
  // AWS access key ids.
  String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
  // GitHub tokens.
  String.raw`\bgh[pousr]_[0-9A-Za-z]{36,}`,
  String.raw`\bgithub_pat_[0-9A-Za-z_]{40,}`,
  // GitLab personal access tokens.
  String.raw`\bglpat-[0-9A-Za-z_-]{20,}`,
  // Model provider and payment keys: sk-..., sk-ant-..., sk-proj-..., sk_live_..., rk_live_...
  String.raw`\bsk-(?:ant-|proj-)?[0-9A-Za-z_-]{32,}`,
  String.raw`\b[rs]k_(?:live|test)_[0-9A-Za-z]{20,}`,
  // Slack tokens.
  String.raw`\bxox[abpors]-[0-9A-Za-z-]{20,}`,
  // Google API keys.
  String.raw`\bAIza[0-9A-Za-z_-]{35}\b`,
  // JSON Web Tokens: three base64url parts, the first two JSON objects.
  String.raw`\beyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}`,
  // A token of 20 or more characters in an Authorization header, an x-api-key header or an
  // api_key setting, such as OPENAI_API_KEY=… in a log.
  String.raw`(?i:\bauthorization["']?\s*:\s*["']?(?:bearer|basic)\s+|api[_-]?key["']?\s*[:=]\s*["']?)[0-9A-Za-z._~+/=-]{20,}`,
  // A user and password in a URL: postgres://user:password@host.
  String.raw`\b[A-Za-z][A-Za-z0-9+.-]*://[^\s:/@]+:[^\s@/]+@`
];

/**
 * A password written out as `password: …`, in English or German, whose value holds a digit or a
 * symbol: "Passwort: kommt separat" is a note, not a password. `Kennwort` is left out, as it is
 * also the reference line of a transfer, and `pwd`, as it is also a working directory.
 */
const PASSWORD_PATTERN = String.raw`(?i)\b(?:password|passwort|passwd)\s*[:=]\s*\S*[0-9!@#$%&*?^+]\S*`;

/**
 * Payment card numbers: 15 to 19 digits that start as Visa (4), Mastercard (51-55, 22-27),
 * American Express (34, 37) or Discover (6011, 65) do, optionally in groups split by single
 * spaces or hyphens. Only those that pass the Luhn check and stand alone count (`checksum:
 * luhn`). Any run of digits would also catch phone numbers, tax numbers, contract numbers and
 * the references of a bank statement, a tenth of which pass the Luhn check by chance.
 */
const CARD_NUMBER_PATTERN = String.raw`\b(?:4[0-9]{3}|5[1-5][0-9]{2}|2[2-7][0-9]{2}|3[47][0-9]{2}|6011|65[0-9]{2})(?:[ -]?[0-9]){11,15}\b`;

/**
 * Statements of special categories of personal data (Art. 9 GDPR): health, religion, union
 * membership, ethnic origin, political opinions, sexual orientation, genetic and biometric data,
 * in German and English. Words a payslip, a tax assessment or a self-disclosure always carries,
 * such as Kirchensteuer, Konfession or Gewerkschaftsbeitrag, are left out.
 */
const SPECIAL_CATEGORY_PATTERN = String.raw`(?i)\b(?:diagnose\b|diagnosen|diagnostiziert|krankschreib|krankgeschrieb|krankmeld|erkrankung|schwerbehind|disabilit|schwanger|pregnan|gesundheitszustand|gesundheitsdaten|health condition|health data|medical condition|hiv\b|religionszugehörigkeit|gewerkschaftsmitglied|trade union|union member|ethnische herkunft|ethnic origin|sexuelle orientierung|sexual orientation|politische meinung|politische überzeugung|political opinion|genetische daten|genetic data|biometrische daten|biometric data)`;

/** The default rules on chat input, by name. Their names start with `chat-`. */
export const CHAT_INPUT_FLOOR_GUARDRAILS = {
  "chat-secrets": {
    displayName: "Secrets in chat",
    description:
      "API keys, access tokens and private keys in a chat message or the text of its attachments.",
    on: CHAT_INPUT_EVENT,
    check: {
      kind: "pattern",
      pattern: SECRET_PATTERNS.join("|"),
      reason:
        "The message contains what looks like an API key, an access token or a private key. Remove it before you send the message, and change the secret if it was shared."
    },
    outcome: "block"
  },
  "chat-passwords": {
    displayName: "Passwords in chat",
    description: "A password written out as 'password: …' in a chat message.",
    on: CHAT_INPUT_EVENT,
    check: {
      kind: "pattern",
      pattern: PASSWORD_PATTERN,
      reason:
        "The message seems to contain a password. Passwords do not belong in a chat; send it only if you are sure."
    },
    outcome: "warn"
  },
  "chat-card-numbers": {
    displayName: "Card numbers in chat",
    description:
      "Payment card numbers of the major card networks that pass the Luhn check, in a chat message.",
    on: CHAT_INPUT_EVENT,
    check: {
      kind: "pattern",
      pattern: CARD_NUMBER_PATTERN,
      checksum: "luhn",
      reason:
        "The message contains what looks like a payment card number. Send it only if the task needs it."
    },
    outcome: "warn"
  },
  "chat-special-categories": {
    displayName: "Special categories of personal data in chat",
    description:
      "Statements of health, religion, union membership or other special categories of personal data (Art. 9 GDPR). Off unless the operator switches it on.",
    on: CHAT_INPUT_EVENT,
    check: {
      kind: "pattern",
      pattern: SPECIAL_CATEGORY_PATTERN,
      reason:
        "The message may contain special categories of personal data, such as health, religion or union membership. Send it only if the task needs them."
    },
    outcome: "warn"
  }
} as const satisfies Record<string, ReleaseGuardrailConfig>;

export type ChatInputFloorGuardrailName = keyof typeof CHAT_INPUT_FLOOR_GUARDRAILS;

/**
 * `chatInputGuardrails` of release config: the operator switches each default rule on chat input
 * off with `false`. All but `chat-special-categories` are on where the key is missing; that one is
 * switched on with `true`, as the words of health and religion stand in many ordinary documents. A guardrail of `guardrails` with the
 * same name takes the default's place.
 */
export const chatInputGuardrailsConfigSchema = z
  .object({
    "chat-secrets": z.boolean().default(true),
    "chat-passwords": z.boolean().default(true),
    "chat-card-numbers": z.boolean().default(true),
    "chat-special-categories": z.boolean().default(false)
  })
  .strict()
  .prefault({}) satisfies z.ZodType<Record<ChatInputFloorGuardrailName, boolean>>;

/**
 * The operator's floor: the default rules on chat input that are switched on, first, and then
 * `guardrails` of release config, whose own entry of the same name wins. Everything that runs or
 * shows the floor reads it here, so `guardrails` stays what the operator wrote.
 */
export function releaseGuardrailFloor(config: {
  guardrails: Readonly<Record<string, ReleaseGuardrailConfig>>;
  chatInputGuardrails: Readonly<Record<ChatInputFloorGuardrailName, boolean>>;
}): Record<string, ReleaseGuardrailConfig> {
  const { guardrails, chatInputGuardrails: switches } = config;
  const defaults: Record<string, ReleaseGuardrailConfig> = {};
  for (const [name, on] of Object.entries(switches)) {
    if (on && !(name in guardrails)) {
      const rule = Object.entries(CHAT_INPUT_FLOOR_GUARDRAILS).find(([key]) => key === name)?.[1];
      if (rule) defaults[name] = rule;
    }
  }
  return { ...defaults, ...guardrails };
}
