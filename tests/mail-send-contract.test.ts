import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  ACTIONS,
  EVENTS,
  GRANTABLE_ACTION_SCOPES,
  MAIL_BODY_MAX_BYTES,
  MAIL_RECIPIENT_ID_PATTERN,
  MAIL_SEND_ERROR_CODES,
  MAIL_SEND_MAX_ADDRESSES,
  MAIL_SEND_OPERATION,
  MAIL_SENDER_ACTIONS,
  MAIL_SENDER_RESOURCE_KIND,
  MAIL_SENDER_SYSTEM,
  MAIL_SENDER_SYSTEM_ICON,
  MAIL_WORKFLOW_MESSAGE_TEMPLATE,
  NOTICE_ID_PATTERN,
  PROVIDER_PORT_FIELDS,
  PRINCIPAL_GRANTABLE_ACTIONS,
  ROLE_DEFAULT_ACTIONS,
  WORKFLOW_MARKDOWN_MAX_COLUMNS,
  WORKFLOW_MARKDOWN_MAX_ROWS,
  WORKFLOW_STEP_SOURCE_KINDS,
  WORKFLOW_TEXT_FORMAT_MARKDOWN,
  WORKFLOW_TEXT_MAX_PARTS,
  mailSendContract,
  mailSendInputSchema,
  mailSendOutputSchema,
  mailSendRefusalDetailsSchema,
  mailSendSimulatedOutputSchema,
  workflowInputTextSchema,
  workflowInputValueSchema,
  workflowMailSenderFactSchema,
  workflowMessageMailParamsSchema,
  type MailSenderId,
  type MailSendInput,
  type WorkflowInputText
} from "@work-shape/catalyst-core";
import { mailSendContract as contractOfApi } from "@work-shape/catalyst-api-contract";
import {
  infrastructureConfigSchema,
  mailOutboundSettingsSchema
} from "@work-shape/catalyst-config-schema";

const mail = {
  to: "miriam.voss@kanzlei.de",
  subject: "Prüfergebnis September 2026 für Bäckerei Krause",
  body: "| Mandant | Befunde |\n| --- | --- |\n| Bäckerei Krause | 3 |"
};

function messages(result: { success: boolean; error?: z.ZodError }): string {
  return (result.error?.issues ?? []).map((issue) => issue.message).join("\n");
}

describe("the input of mail.send", () => {
  it("takes one address, a subject and a Markdown body, as the system sender", () => {
    const input = mailSendInputSchema.parse(mail);
    expect(input).toEqual({ ...mail, sender: MAIL_SENDER_SYSTEM });
    expectTypeOf<MailSendInput["sender"]>().toEqualTypeOf<MailSenderId>();
  });

  it("takes literal recipients, addresses and records of an earlier result in one list", () => {
    const parsed = mailSendInputSchema.parse({
      ...mail,
      to: [
        "a@kanzlei.de",
        { address: "b@kanzlei.de" },
        { user: "user_miriam" },
        { workspace: "ws-steuer" },
        { email: "c@kanzlei.de", name: "Bäckerei Krause", findings: 3 }
      ],
      cc: [{ user: "user_tim" }],
      bcc: "archiv@kanzlei.de",
      senderName: "Mandanten-Check",
      replyTo: { user: "user_miriam" },
      locale: "de"
    });
    expect(parsed.to).toHaveLength(5);
  });

  it("refuses an empty list, more than 50 entries and a record without an address", () => {
    expect(mailSendInputSchema.safeParse({ ...mail, to: [] }).success).toBe(false);
    const many = Array.from({ length: MAIL_SEND_MAX_ADDRESSES + 1 }, (_, i) => `p${i}@kanzlei.de`);
    expect(mailSendInputSchema.safeParse({ ...mail, to: many }).success).toBe(false);
    expect(mailSendInputSchema.safeParse({ ...mail, to: [{ name: "Krause" }] }).success).toBe(
      false
    );
    expect(mailSendInputSchema.safeParse({ ...mail, to: ["not an address"] }).success).toBe(false);
  });

  it("takes an empty cc and bcc, as a referenced list with nobody in it resolves", () => {
    const parsed = mailSendInputSchema.parse({ ...mail, cc: [], bcc: [] });
    expect(parsed).toMatchObject({ cc: [], bcc: [] });
    const many = Array.from({ length: MAIL_SEND_MAX_ADDRESSES + 1 }, (_, i) => `p${i}@kanzlei.de`);
    expect(mailSendInputSchema.safeParse({ ...mail, cc: many }).success).toBe(false);
  });

  it("refuses a workspace as Reply-To and a language the instance has no frame in", () => {
    expect(mailSendInputSchema.safeParse({ ...mail, replyTo: { workspace: "ws" } }).success).toBe(
      false
    );
    expect(mailSendInputSchema.safeParse({ ...mail, locale: "fr" }).success).toBe(false);
  });

  it("refuses a subject that is not one line of 1 to 200 characters", () => {
    for (const subject of ["", "   ", "a\nBcc: x@evil.example", "a\rb", "a b", "x".repeat(201)]) {
      expect(mailSendInputSchema.safeParse({ ...mail, subject }).success, subject).toBe(false);
    }
    expect(mailSendInputSchema.safeParse({ ...mail, subject: "x".repeat(200) }).success).toBe(true);
  });

  it("refuses a sender name with an @ or a line break", () => {
    for (const senderName of ["noreply@other.example", "Catalyst\nFrom: x", "x".repeat(81), ""]) {
      expect(mailSendInputSchema.safeParse({ ...mail, senderName }).success, senderName).toBe(
        false
      );
    }
  });

  it("bounds the body at 64 KiB of UTF-8, not of characters", () => {
    const umlauts = "ä".repeat(MAIL_BODY_MAX_BYTES / 2 + 1);
    expect(umlauts.length).toBeLessThan(MAIL_BODY_MAX_BYTES);
    expect(messages(mailSendInputSchema.safeParse({ ...mail, body: umlauts }))).toContain(
      "input_invalid"
    );
    expect(
      mailSendInputSchema.safeParse({ ...mail, body: "a".repeat(MAIL_BODY_MAX_BYTES) }).success
    ).toBe(true);
  });

  it("reserves Connection senders and attachments for later tickets", () => {
    expect(
      messages(mailSendInputSchema.safeParse({ ...mail, sender: "connection.kanzlei-m365" }))
    ).toContain("not_supported_yet");
    expect(mailSendInputSchema.safeParse({ ...mail, sender: "mailjet" }).success).toBe(false);
    expect(
      mailSendInputSchema.safeParse({ ...mail, attachments: [{ file: "file_1" }] }).success
    ).toBe(false);
  });

  it("marks the body as Markdown and the subject as one line in its JSON Schema", () => {
    const schema = z
      .looseObject({
        properties: z.record(z.string(), z.looseObject({ pattern: z.string().optional() })),
        required: z.array(z.string())
      })
      .parse(z.toJSONSchema(mailSendInputSchema, { io: "input", unrepresentable: "any" }));
    const { properties } = schema;
    expect(properties.body).toMatchObject({
      type: "string",
      format: WORKFLOW_TEXT_FORMAT_MARKDOWN
    });
    expect(properties.subject).toMatchObject({ type: "string", maxLength: 200 });
    expect(properties.subject?.pattern).toEqual(expect.any(String));
    expect(schema.required).toEqual(["to", "subject", "body"]);
  });
});

describe("what mail.send answers", () => {
  it("is counts and the provider's message id, never an address", () => {
    const output = {
      sentAt: "2026-10-19T07:42:00.000Z",
      messageId: "1152921526385432190",
      recipients: { to: 2, cc: 1, bcc: 1 },
      skipped: 0
    };
    expect(mailSendOutputSchema.parse(output)).toEqual(output);
    expect(mailSendOutputSchema.safeParse({ ...output, to: ["a@kanzlei.de"] }).success).toBe(false);
    expect(
      mailSendOutputSchema.safeParse({
        ...output,
        recipients: { to: ["a@kanzlei.de"], cc: 0, bcc: 0 }
      }).success
    ).toBe(false);
    expect(mailSendOutputSchema.parse({ ...output, test: true }).test).toBe(true);
  });

  it("answers a simulated call with the mail as it would go out", () => {
    const preview = {
      from: { name: "Workshape Catalyst", address: "noreply@catalyst.example" },
      to: [{ kind: "person", label: "Miriam Voss" }],
      cc: [],
      bcc: [{ kind: "address", label: "archiv@kanzlei.de" }],
      skipped: 0,
      subject: mail.subject,
      html: "<p>…</p>",
      text: "…"
    };
    expect(mailSendSimulatedOutputSchema.parse({ simulated: true, preview }).preview).toEqual(
      preview
    );
    expect(mailSendSimulatedOutputSchema.safeParse({ simulated: true }).success).toBe(false);
  });

  it("refuses with one of three codes, naming the domain of a refused recipient", () => {
    expect(Object.values(MAIL_SEND_ERROR_CODES)).toEqual([
      "recipient_not_allowed",
      "no_recipient",
      "mail_rejected"
    ]);
    expect(
      mailSendRefusalDetailsSchema.parse({ reason: "recipient_not_allowed", domain: "gmail.com" })
    ).toEqual({ reason: "recipient_not_allowed", domain: "gmail.com" });
    expect(
      mailSendRefusalDetailsSchema.safeParse({ reason: "recipient_not_allowed" }).success
    ).toBe(false);
    expect(
      mailSendRefusalDetailsSchema.parse({ reason: "mail_rejected", providerCode: "mj-18" })
    ).toBeTruthy();
    expect(
      mailSendRefusalDetailsSchema.safeParse({ reason: "no_recipient", address: "a@b.de" }).success
    ).toBe(false);
  });
});

describe("the contract descriptor", () => {
  it("is one outward, changing operation on the mail sender, the same from core and the API contract", () => {
    expect(contractOfApi).toBe(mailSendContract);
    expect(mailSendContract).toMatchObject({
      name: MAIL_SEND_OPERATION,
      effect: "changing",
      changeClass: "outward",
      right: "mail_sender.use",
      resourceKind: MAIL_SENDER_RESOURCE_KIND,
      events: { after: "mail.sent", refused: "mail.refused" }
    });
    expect(MAIL_SEND_OPERATION).toBe("mail.send");
  });
});

describe("the template workflow-message", () => {
  it("takes the subject, the Markdown and who sent it; the frame is the instance's", () => {
    expect(MAIL_WORKFLOW_MESSAGE_TEMPLATE).toBe("workflow-message");
    const params = {
      subject: mail.subject,
      markdown: mail.body,
      sentBy: { kind: "workflow", workflowName: "Mandanten-Check" }
    };
    expect(workflowMessageMailParamsSchema.parse(params)).toEqual(params);
    expect(
      workflowMessageMailParamsSchema.parse({
        ...params,
        sentBy: { kind: "agent", onBehalfOf: "Miriam Voss" },
        test: { intendedRecipients: { to: [{ kind: "person", label: "Tim" }], cc: [], bcc: [] } }
      }).test
    ).toBeDefined();
    expect(
      workflowMessageMailParamsSchema.safeParse({ ...params, logoUrl: "https://x" }).success
    ).toBe(false);
  });
});

describe("infrastructure.mail.outbound", () => {
  const models = { local: { provider: "deterministic" } };
  const mailEntry = {
    provider: "capture",
    appUrl: "http://127.0.0.1:5274",
    sender: { fromAddress: "noreply@catalyst.example" }
  };

  it("is off, with no outside domain and the release's limits, unless release config says more", () => {
    const parsed = infrastructureConfigSchema.parse({ models, mail: mailEntry });
    expect(parsed.mail?.outbound).toEqual({
      enabled: false,
      recipientDomains: [],
      limits: { perWorkflowPerHour: 200, perInstancePerDay: 1000 }
    });
  });

  it("belongs to the mail port, so no adapter's schema reads it", () => {
    expect(PROVIDER_PORT_FIELDS.mail).toContain("outbound");
  });

  it("cannot be switched on without a mail provider", () => {
    const { provider: _provider, ...withoutProvider } = mailEntry;
    const result = infrastructureConfigSchema.safeParse({
      models,
      mail: { ...withoutProvider, outbound: { enabled: true } }
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("mail.provider");
  });

  it("lists lowercase domains, subdomains as *.domain, and * alone", () => {
    const ok = mailOutboundSettingsSchema.parse({
      enabled: true,
      recipientDomains: ["kanzlei.de", "*.kanzlei.de", "xn--mller-kva.de"],
      limits: { perWorkflowPerHour: 3 },
      footer: { de: "Workshape GmbH · Amtsgericht Berlin HRB 1" }
    });
    expect(ok.limits).toEqual({ perWorkflowPerHour: 3, perInstancePerDay: 1000 });
    expect(mailOutboundSettingsSchema.parse({ recipientDomains: ["*"] }).recipientDomains).toEqual([
      "*"
    ]);
    for (const recipientDomains of [
      ["Kanzlei.de"],
      ["@kanzlei.de"],
      ["kanzlei"],
      ["*kanzlei.de"],
      ["*", "kanzlei.de"],
      ["kanzlei.de", "kanzlei.de"]
    ]) {
      expect(
        mailOutboundSettingsSchema.safeParse({ recipientDomains }).success,
        recipientDomains.join(",")
      ).toBe(false);
    }
  });

  it("refuses a limit of zero, an empty footer and a footer in a language without a frame", () => {
    expect(mailOutboundSettingsSchema.safeParse({ limits: { perInstancePerDay: 0 } }).success).toBe(
      false
    );
    expect(mailOutboundSettingsSchema.safeParse({ footer: {} }).success).toBe(false);
    expect(mailOutboundSettingsSchema.safeParse({ footer: { fr: "SARL" } }).success).toBe(false);
    expect(mailOutboundSettingsSchema.safeParse({ footer: { en: "  " } }).success).toBe(false);
    expect(mailOutboundSettingsSchema.safeParse({ provider: "mailjet" }).success).toBe(false);
  });
});

describe("the events of mail.send", () => {
  const forbidden = /address|email|subject|body|name|text|html/iu;
  function propertyNames(schema: unknown): string[] {
    if (typeof schema !== "object" || schema === null) return [];
    const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    return Object.entries(properties).flatMap(([key, value]) => [key, ...propertyNames(value)]);
  }

  it("are audited after-events about the sender, with counts and domains only", () => {
    for (const name of ["mail.sent", "mail.refused"] as const) {
      const event = EVENTS[name];
      expect(event).toMatchObject({
        name,
        subject: MAIL_SENDER_RESOURCE_KIND,
        legacy: false,
        audited: true,
        phases: ["after"]
      });
      expect(event.payload).toMatchObject({ additionalProperties: false });
      expect(propertyNames(event.payload).filter((key) => forbidden.test(key))).toEqual([]);
    }
    expect(EVENTS["mail.sent"].payload.properties.domains).toMatchObject({ maxItems: 10 });
    expect(EVENTS["mail.refused"].payload.properties.reason).toEqual({
      enum: ["recipient_not_allowed", "no_recipient", "mail_rejected"]
    });
  });
});

describe("the right mail_sender.use", () => {
  it("is held by admin and superadmin, not by members, and a principal may be given it", () => {
    expect(ACTIONS).toContain("mail_sender.use");
    expect(MAIL_SENDER_ACTIONS).toEqual({ use: "mail_sender.use" });
    expect(ROLE_DEFAULT_ACTIONS.admin).toContain("mail_sender.use");
    expect(ROLE_DEFAULT_ACTIONS.superadmin).toContain("mail_sender.use");
    expect(ROLE_DEFAULT_ACTIONS.user).not.toContain("mail_sender.use");
    expect(PRINCIPAL_GRANTABLE_ACTIONS).toContain("mail_sender.use");
  });

  it("is granted on one named sender and never at instance scope", () => {
    expect(GRANTABLE_ACTION_SCOPES["mail_sender.use"]).toEqual(["asset"]);
  });

  it("names recipients by the ids notices name them by", () => {
    expect(MAIL_RECIPIENT_ID_PATTERN.source).toBe(NOTICE_ID_PATTERN.source);
  });
});

describe("the step facts of a mail.send step", () => {
  it("name the sender as a source of kind mail_sender with its icon, address and domains", () => {
    expect(WORKFLOW_STEP_SOURCE_KINDS).toContain("mail_sender");
    expect(MAIL_SENDER_SYSTEM_ICON).toBe("system-mail");
    const fact = {
      sender: "system",
      title: "Workshape Catalyst",
      icon: MAIL_SENDER_SYSTEM_ICON,
      address: "noreply@catalyst.example",
      recipientDomains: ["kanzlei.de"]
    };
    expect(workflowMailSenderFactSchema.parse(fact)).toEqual(fact);
    expect(workflowMailSenderFactSchema.safeParse({ ...fact, provider: "mailjet" }).success).toBe(
      false
    );
  });
});

describe("the text value form", () => {
  it("joins literal strings and references in order", () => {
    const value = {
      text: [
        "Prüfergebnis ",
        { ref: { step: "monat", path: "label" } },
        " für ",
        { ref: { step: "mandant", path: "name" } }
      ]
    };
    expect(workflowInputTextSchema.parse(value)).toEqual(value);
    expectTypeOf(value).toExtend<WorkflowInputText>();
  });

  it("refuses an empty text, a part that is no string or reference, and too many parts", () => {
    expect(workflowInputTextSchema.safeParse({ text: [] }).success).toBe(false);
    expect(workflowInputTextSchema.safeParse({ text: [3] }).success).toBe(false);
    expect(workflowInputTextSchema.safeParse({ text: [{ value: "x" }] }).success).toBe(false);
    expect(
      workflowInputTextSchema.safeParse({ text: ["a"], ref: { step: "s", path: "" } }).success
    ).toBe(false);
    expect(
      workflowInputTextSchema.safeParse({ text: Array(WORKFLOW_TEXT_MAX_PARTS + 1).fill("a") })
        .success
    ).toBe(false);
    expect([WORKFLOW_MARKDOWN_MAX_ROWS, WORKFLOW_MARKDOWN_MAX_COLUMNS]).toEqual([100, 8]);
  });

  it("is a value of a mapping beside a literal and a reference (EW-TEXT)", () => {
    expect(workflowInputValueSchema.safeParse({ text: ["a"] }).success).toBe(true);
    expect(workflowInputValueSchema.safeParse({ text: ["a"], value: "b" }).success).toBe(false);
  });
});
