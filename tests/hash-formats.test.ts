import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, unknownToJsonValue } from "@work-shape/catalyst-core";
import { fingerprintOperation } from "@work-shape/catalyst-connections";
import { serializeSkillMarkdown, renderCatalystSkill } from "@work-shape/catalyst-cli";

// These fixed outputs were captured before consolidating serializers and SHA-256 helpers.
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const input = { z: [null, "Grüße 🧪", { b: false, a: -0 }], "2": 2, "10": 10, a: {} };

describe("stored hash formats", () => {
  it("keeps operation input hashes and lexical numeric keys", () => {
    expect({ json: canonicalJson(input), hash: hash(canonicalJson(input)) }).toMatchInlineSnapshot(`
      {
        "hash": "2822a72aade030f995e7ecc7464fc9b2f034418094f0d7b9b2dc0df43f433c8a",
        "json": "{"10":10,"2":2,"a":{},"z":[null,"Grüße 🧪",{"a":0,"b":false}]}",
      }
    `);
    expect(
      hash(canonicalJson(unknownToJsonValue({ b: undefined, a: [undefined, NaN] })))
    ).toMatchInlineSnapshot(`"34f907696f4aaac2d8a53a948633a40b8d0d4cbae7ec475c7b33997d8d3c6438"`);
  });

  it("keeps descriptor fingerprints, with and without an output schema", () => {
    const descriptor = {
      name: "read",
      description: "Reads Grüße.",
      inputSchema: input,
      proposedEffect: "reading" as const
    };
    expect(fingerprintOperation(descriptor)).toMatchInlineSnapshot(
      `"27a1728a961d815ccf4c47950195482ccb5b7188272f4bf3743f6662bc1f3d88"`
    );
    expect(
      fingerprintOperation({
        ...descriptor,
        outputSchema: { type: "object", properties: { "2": {}, "10": {} } }
      })
    ).toMatchInlineSnapshot(`"601c94fc307c6d9508af734881a11d725739098109789d1875536e182a52bfd9"`);
  });

  it("keeps the CLI's locale-sorted frontmatter format", () => {
    const contents = serializeSkillMarkdown({
      name: "guide",
      title: "Guide",
      description: "Guide",
      content: "# Guide",
      frontmatter: { Z: "upper", a: "lower", ä: "umlaut", "2": "two", "10": "ten" }
    });
    expect({ contents, hash: hash(contents) }).toMatchInlineSnapshot(`
      {
        "contents": "---
      '2': two
      '10': ten
      a: lower
      ä: umlaut
      Z: upper
      name: guide
      title: Guide
      description: Guide
      ---

      # Guide
      ",
        "hash": "bab83260d3cbc826dac4d6b2ccf416982f0bcf392e9907b52750a6ed350d9d9e",
      }
    `);
  });

  it("keeps setup's persisted content marker", async () => {
    const rendered = await renderCatalystSkill();
    expect(rendered.match(/sha256 ([0-9a-f]{64})/u)?.[1]).toMatchInlineSnapshot(
      `"283fb500cf8b6fc5eeffca96433d25b3e52788853be2786ce16acfb7a84f1aa8"`
    );
  });
});
