import { ProviderRegistry } from "@work-shape/catalyst-core";
import { describe, expect, it, vi } from "vitest";
import { renderMail, mailProviderDefinitions } from "@work-shape/catalyst-mail";
import { noticeMailSettingsSchema } from "@work-shape/catalyst-config-schema";

const notice = { title: "Sensitive Mandant title", text: "Confidential finding account 4711" };
describe("notice mail's content boundary", () => {
  it("treats batching settings as mail port fields for every existing adapter", () => {
    const registry = new ProviderRegistry(mailProviderDefinitions);
    for (const provider of ["mailjet", "capture"]) {
      const entry = {
        provider,
        appUrl: "https://chat.example.test",
        sender: { fromAddress: "noreply@example.test" },
        notices: noticeMailSettingsSchema.parse({}),
        ...(provider === "mailjet"
          ? { region: "eu", apiKeySecret: "MAIL_KEY", apiSecretSecret: "MAIL_SECRET" }
          : {})
      };
      expect(() => registry.validate("mail", { path: "infrastructure.mail", entry })).not.toThrow();
    }
  });

  it("renders only counts and a link even when the source notice has sensitive fields", () => {
    for (const locale of ["de", "en"] as const) {
      const message = {
        ...notice,
        template: "workflow-notice" as const,
        to: { email: "ada@example.test" },
        locale,
        params: { count: 17, link: "https://chat.example.test/inbox" }
      };
      const mail = renderMail(message, {
        fromAddress: "noreply@example.test",
        fromName: "Example",
        productName: "Example"
      });
      expect(mail.text).toContain("17");
      expect(mail.html).toContain('href="https://chat.example.test/inbox"');
      for (const part of [mail.subject, mail.text, mail.html]) {
        expect(part).not.toContain(notice.title);
        expect(part).not.toContain(notice.text);
        expect(part).not.toContain("4711");
      }
    }
  });

  it.each([
    {
      locale: "en",
      count: 1,
      subject: "A new notice",
      body: "1 notice is waiting",
      read: "read it",
      action: "Open the notice:"
    },
    {
      locale: "en",
      count: 3,
      subject: "New notices",
      body: "3 notices are waiting",
      read: "read them",
      action: "Open the notices:"
    },
    {
      locale: "de",
      count: 1,
      subject: "Neue Mitteilung",
      body: "wartet 1 Mitteilung.",
      read: "sie zu lesen",
      action: "Mitteilung öffnen:"
    },
    {
      locale: "de",
      count: 3,
      subject: "Neue Mitteilungen",
      body: "warten 3 Mitteilungen.",
      read: "sie zu lesen",
      action: "Mitteilungen öffnen:"
    }
  ] as const)(
    "uses the right subject and body for $count notices in $locale",
    ({ locale, count, subject, body, read, action }) => {
      const mail = renderMail(
        {
          template: "workflow-notice",
          to: { email: "ada@example.test" },
          locale,
          params: { count, link: "https://chat.example.test/inbox" }
        },
        { fromAddress: "noreply@example.test", fromName: "Example", productName: "Example" }
      );
      expect(mail.subject).toBe(`${subject} in Example`);
      expect(mail.text).toContain(body);
      expect(mail.html).toContain(body);
      expect(mail.text).toContain(read);
      expect(mail.text).toContain(action);
    }
  );

  it("refuses only intervals whose delivery date cannot be represented", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const lastRepresentableInterval = 8_640_000_000_000_000 - 1000;
      expect(
        noticeMailSettingsSchema.parse({ digestIntervalMs: lastRepresentableInterval })
          .digestIntervalMs
      ).toBe(lastRepresentableInterval);
      for (const digestIntervalMs of [lastRepresentableInterval + 1, 9e15]) {
        expect(noticeMailSettingsSchema.safeParse({ digestIntervalMs }).success).toBe(false);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("has operator defaults without an arbitrary maximum and rejects invalid settings", () => {
    expect(noticeMailSettingsSchema.parse({})).toEqual({
      batchSize: 100,
      digestIntervalMs: 300000
    });
    expect(
      noticeMailSettingsSchema.parse({ batchSize: 10000, digestIntervalMs: 86400000 })
    ).toEqual({ batchSize: 10000, digestIntervalMs: 86400000 });
    for (const value of [0, -1, 1.5, NaN, Infinity, "100"]) {
      expect(noticeMailSettingsSchema.safeParse({ batchSize: value }).success).toBe(false);
      expect(noticeMailSettingsSchema.safeParse({ digestIntervalMs: value }).success).toBe(false);
    }
  });
});
