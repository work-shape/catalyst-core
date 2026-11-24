import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CaptureMailTransport,
  MailjetTransport,
  TemplateMailSender,
  allowedLinkTarget,
  createInlineImageLoader,
  mailAccentColor,
  mailProviderDefinitions,
  renderMail,
  renderMailMarkdown,
  type MailSenderIdentity,
  type WorkflowMessageMailMessage
} from "@work-shape/catalyst-mail";
import { ProviderRegistry, mailDomainAllowed, mailDomainOf } from "@work-shape/catalyst-core";
import { noticeMailSettingsSchema } from "@work-shape/catalyst-config-schema";

// MAIL-1: what leaves the instance in a mail of `mail.send`. Events checks 130, 131 and 132.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const identity: MailSenderIdentity = {
  fromAddress: "catalyst@mail.example.test",
  fromName: "Example Catalyst",
  productName: "Example Catalyst",
  frame: { accentColor: "#0a7f5a", footer: { de: "Beispiel GmbH\nAmtsgericht X" } }
};

function message(
  markdown: string,
  overrides: Partial<WorkflowMessageMailMessage> = {}
): WorkflowMessageMailMessage {
  return {
    template: "workflow-message",
    params: {
      subject: "Monatscheck <b>März</b>",
      markdown,
      sentBy: { kind: "workflow", workflowName: "Mandanten-Check" }
    },
    to: [{ email: "a@kanzlei.de" }],
    locale: "de",
    ...overrides
  };
}

/** Every URL the HTML would have a client load: images, styles, frames and scripts. */
function loadedUrls(html: string): string[] {
  return [...html.matchAll(/\b(?:src|background|srcset)\s*=\s*"([^"]*)"/giu)].map(
    (m) => m[1] ?? ""
  );
}

describe("the Markdown of a mail's body", () => {
  it("shows raw HTML and a referenced name as text, drops images and unsafe links", () => {
    const { html, text } = renderMailMarkdown(
      [
        "Mandant: [Klick](https://evil.example) <img src=https://x.example/p.png>",
        "",
        '<script>alert("x")</script>',
        "",
        "![pixel](https://tracker.example/p.gif)",
        "",
        "[run](javascript:alert(1)) and [ok](https://kanzlei.de/a?b=1&c=2)"
      ].join("\n"),
      { accentColor: "#0a7f5a" }
    );
    expect(html).not.toMatch(/<img|<script/iu);
    expect(html).toContain("&lt;img src=https://x.example/p.png&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("tracker.example");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://kanzlei.de/a?b=1&amp;c=2"');
    expect(loadedUrls(html)).toEqual([]);
    expect(text).toContain("run and ok (https://kanzlei.de/a?b=1&c=2)");
  });

  it("links only over https, http and mailto", () => {
    expect(allowedLinkTarget("https://a.example/x")).toBe("https://a.example/x");
    expect(allowedLinkTarget("mailto:a@b.example")).toBe("mailto:a@b.example");
    for (const url of ["javascript:alert(1)", "data:text/html,x", "/relative", "vbscript:x"])
      expect(allowedLinkTarget(url), url).toBeUndefined();
  });
});

describe("the template workflow-message", () => {
  it("escapes the subject in the frame and keeps a colour that is no colour out of a style", async () => {
    const sender = new TemplateMailSender(new CaptureMailTransport(), identity);
    const mail = await sender.preview(message("Hallo"));
    expect(mail.subject).toBe("Monatscheck <b>März</b>");
    expect(mail.html).toContain("Monatscheck &lt;b&gt;März&lt;/b&gt;");
    expect(mail.html).toContain("#0a7f5a");
    expect(mailAccentColor("red;background:url(x)")).toBe("#b5573a");
  });

  it("embeds the logo in the mail and never links it from a host", async () => {
    const read = vi.fn<typeof fetch>(async () => new Response(PNG));
    const logo = createInlineImageLoader({
      url: "/brand/logo.png",
      baseUrl: "https://chat.example.test",
      contentId: "logo",
      fetch: read
    });
    const capture = new CaptureMailTransport();
    const sender = new TemplateMailSender(capture, {
      ...identity,
      frame: { accentColor: "#0a7f5a", logo }
    });
    await sender.send(message("Hallo"));
    await sender.send(message("Nochmal"));
    expect(read).toHaveBeenCalledTimes(1);
    expect(String(read.mock.calls[0]?.[0])).toBe("https://chat.example.test/brand/logo.png");
    const [sent] = capture.list();
    expect(sent?.html).toContain('src="cid:logo"');
    expect(sent?.inlineImages).toEqual([
      { contentId: "logo", contentType: "image/png", bytes: PNG.byteLength }
    ]);
    // An SVG or anything else that is no PNG, JPEG or GIF leaves the name alone.
    const svg = createInlineImageLoader({
      url: "https://chat.example.test/logo.svg",
      contentId: "logo",
      fetch: async () => new Response("<svg/>")
    });
    await expect(svg()).resolves.toBeUndefined();
  });
});

describe("the envelope in the adapters", () => {
  const rendered = {
    to: [{ email: "a@kanzlei.de", displayLabel: "Anna" }, { email: "b@kanzlei.de" }],
    cc: [{ email: "pia@elsewhere.test", displayLabel: "Pia" }],
    bcc: [{ email: "c@kanzlei.de" }],
    replyTo: { email: "office@kanzlei.de" },
    fromName: "Kanzlei Team",
    subject: "S",
    text: "T",
    html: "<p>H</p>",
    inlineImages: [
      {
        contentId: "logo",
        contentType: "image/png" as const,
        filename: "logo.png",
        content: PNG
      }
    ]
  };

  it("sends From name, To, Cc, Bcc, Reply-To and the inline logo to Mailjet", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ Messages: [{ Status: "success", To: [{ MessageID: 288230 }] }] })
        )
    );
    const transport = new MailjetTransport({ apiKey: "k", apiSecret: "s", fetch: fetchMock });
    expect(await transport.deliver(rendered, identity)).toEqual({ ok: true, messageId: "288230" });
    const body = z
      .object({ Messages: z.array(z.unknown()) })
      .parse(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)));
    expect(body.Messages[0]).toEqual({
      From: { Email: "catalyst@mail.example.test", Name: "Kanzlei Team" },
      To: [{ Email: "a@kanzlei.de", Name: "Anna" }, { Email: "b@kanzlei.de" }],
      Cc: [{ Email: "pia@elsewhere.test", Name: "Pia" }],
      Bcc: [{ Email: "c@kanzlei.de" }],
      ReplyTo: { Email: "office@kanzlei.de" },
      Subject: "S",
      TextPart: "T",
      HTMLPart: "<p>H</p>",
      InlinedAttachments: [
        {
          ContentType: "image/png",
          Filename: "logo.png",
          ContentID: "logo",
          Base64Content: Buffer.from(PNG).toString("base64")
        }
      ]
    });
  });

  it("tells a refusal, a connection never made and a lost answer apart", async () => {
    const answering = (response: () => Response) =>
      new MailjetTransport({ apiKey: "k", apiSecret: "s", fetch: async () => response() });
    const refusal = answering(
      () =>
        new Response(
          JSON.stringify({ Messages: [{ Status: "error", Errors: [{ ErrorCode: "mj-0013" }] }] }),
          { status: 400 }
        )
    );
    expect(await refusal.deliver(rendered, identity)).toMatchObject({
      ok: false,
      failure: "rejected",
      providerCode: "mj-0013"
    });
    expect(
      await answering(() => new Response("{}", { status: 503 })).deliver(rendered, identity)
    ).toMatchObject({ ok: false, failure: "uncertain" });
    expect(
      await answering(() => new Response("{}", { status: 429 })).deliver(rendered, identity)
    ).toMatchObject({ ok: false, failure: "unsent" });
    const refused = new MailjetTransport({
      apiKey: "k",
      apiSecret: "s",
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      }
    });
    expect(await refused.deliver(rendered, identity)).toMatchObject({
      ok: false,
      failure: "unsent"
    });
  });
});

describe("the recipient domains", () => {
  it("matches a listed domain exactly, *.x its subdomains only and * everything", () => {
    expect(mailDomainOf("Anna@Kanzlei.DE")).toBe("kanzlei.de");
    expect(mailDomainAllowed("kanzlei.de", ["kanzlei.de"])).toBe(true);
    expect(mailDomainAllowed("steuer.kanzlei.de", ["kanzlei.de"])).toBe(false);
    expect(mailDomainAllowed("steuer.kanzlei.de", ["*.kanzlei.de"])).toBe(true);
    expect(mailDomainAllowed("kanzlei.de", ["*.kanzlei.de"])).toBe(false);
    expect(mailDomainAllowed("evilkanzlei.de", ["*.kanzlei.de"])).toBe(false);
    expect(mailDomainAllowed("gmail.com", ["*"])).toBe(true);
    expect(mailDomainAllowed("gmail.com", [])).toBe(false);
  });
});

describe("notice mail's content boundary", () => {
  const notice = { title: "Sensitive Mandant title", text: "Confidential finding account 4711" };

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
      const mail = renderMail(
        {
          ...notice,
          template: "workflow-notice" as const,
          to: { email: "ada@example.test" },
          locale,
          params: { count: 17, link: "https://chat.example.test/inbox" }
        },
        { fromAddress: "noreply@example.test", fromName: "Example", productName: "Example" }
      );
      expect(mail.text).toContain("17");
      expect(mail.html).toContain('href="https://chat.example.test/inbox"');
      for (const part of [mail.subject, mail.text, mail.html]) {
        expect(part).not.toContain(notice.title);
        expect(part).not.toContain(notice.text);
        expect(part).not.toContain("4711");
      }
    }
  });

  it("refuses only intervals whose delivery date cannot be represented", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const lastRepresentableInterval = 8_640_000_000_000_000 - 1000;
      expect(
        noticeMailSettingsSchema.parse({ digestIntervalMs: lastRepresentableInterval })
          .digestIntervalMs
      ).toBe(lastRepresentableInterval);
      expect(
        noticeMailSettingsSchema.safeParse({ digestIntervalMs: lastRepresentableInterval + 1 })
          .success
      ).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("has operator defaults without an arbitrary maximum and rejects invalid settings", () => {
    expect(noticeMailSettingsSchema.parse({})).toEqual({
      batchSize: 100,
      digestIntervalMs: 300000
    });
    expect(noticeMailSettingsSchema.parse({ batchSize: 10000 }).batchSize).toBe(10000);
    for (const value of [0, 1.5, "100"]) {
      expect(noticeMailSettingsSchema.safeParse({ batchSize: value }).success).toBe(false);
      expect(noticeMailSettingsSchema.safeParse({ digestIntervalMs: value }).success).toBe(false);
    }
  });
});
