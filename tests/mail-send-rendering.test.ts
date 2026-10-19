import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CaptureMailTransport,
  MailjetTransport,
  TemplateMailSender,
  allowedLinkTarget,
  createInlineImageLoader,
  mailAccentColor,
  renderMailMarkdown,
  type MailSenderIdentity,
  type WorkflowMessageMailMessage
} from "@work-shape/catalyst-mail";
import { mailDomainAllowed, mailDomainOf } from "@work-shape/catalyst-core";

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

  it("renders a table, lists and headings, and a text part beside them", () => {
    const { html, text } = renderMailMarkdown(
      "## Befunde\n\n| Mandant | Offen |\n| --- | ---: |\n| A & B | 2 |\n\n- eins\n- zwei",
      { accentColor: "#0a7f5a" }
    );
    expect(html).toContain("<h2");
    expect(html).toContain("<table");
    expect(html).toContain("A &amp; B");
    expect(html).toContain("text-align:right;");
    expect(html).toContain("<ul");
    expect(text).toContain("Mandant | Offen\nA & B | 2");
    expect(text).toContain("- eins\n- zwei");
  });

  it("links only over https, http and mailto", () => {
    expect(allowedLinkTarget("https://a.example/x")).toBe("https://a.example/x");
    expect(allowedLinkTarget("mailto:a@b.example")).toBe("mailto:a@b.example");
    for (const url of ["javascript:alert(1)", "data:text/html,x", "/relative", "vbscript:x"])
      expect(allowedLinkTarget(url), url).toBeUndefined();
  });
});

describe("the template workflow-message", () => {
  it("frames the body with the instance's name, accent colour and footers, escaping the subject", async () => {
    const sender = new TemplateMailSender(new CaptureMailTransport(), identity);
    const mail = await sender.preview(message("Hallo"));
    expect(mail.subject).toBe("Monatscheck <b>März</b>");
    expect(mail.html).toContain("Monatscheck &lt;b&gt;März&lt;/b&gt;");
    expect(mail.html).toContain("#0a7f5a");
    expect(mail.html).toContain("Example Catalyst");
    expect(mail.html).toContain("Der Workflow „Mandanten-Check“ von Example Catalyst hat diese");
    expect(mail.html).toContain("Beispiel GmbH<br>Amtsgericht X");
    expect(mail.text).toContain("Hallo\n\n--\n\nDer Workflow");
    const english = await sender.preview(
      message("Hi", {
        locale: "en",
        params: {
          subject: "S",
          markdown: "Hi",
          sentBy: { kind: "agent", onBehalfOf: "Ada" }
        }
      })
    );
    expect(english.text).toContain(
      "An agent of Example Catalyst sent this e-mail on behalf of Ada."
    );
    // A colour that is no colour never reaches a style.
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

  it("captures the envelope as a provider would send it", async () => {
    const capture = new CaptureMailTransport();
    const result = await capture.deliver(rendered, identity);
    expect(result).toMatchObject({ ok: true, messageId: expect.stringMatching(/^capture-/u) });
    expect(capture.list()[0]).toMatchObject({
      from: { email: "catalyst@mail.example.test", name: "Kanzlei Team" },
      to: { email: "a@kanzlei.de", displayLabel: "Anna" },
      recipients: {
        to: rendered.to,
        cc: rendered.cc,
        bcc: rendered.bcc
      },
      replyTo: { email: "office@kanzlei.de" },
      inlineImages: [{ contentId: "logo", contentType: "image/png", bytes: PNG.byteLength }]
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
