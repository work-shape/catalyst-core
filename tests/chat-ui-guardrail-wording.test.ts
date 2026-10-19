import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";

// ACCEPT-FIX-10 B1: the guardrails page said further guardrails are written "with the CLI or the
// Build Agent", but the Build Agent cannot write one. The page names only the way that works.

describe("the guardrails page's account of where guardrails come from", () => {
  it("names the CLI and does not promise the Build Agent, in English and German", () => {
    const keys = ["guardrails.description", "guardrails.empty"] as const;
    for (const locale of ["en", "de"] as const) {
      const { t } = createTranslationContext(locale);
      for (const key of keys) {
        const text = t(key);
        expect(text).toContain("CLI");
        expect(text).not.toMatch(/Build[- ]Agent/u);
      }
    }
  });
});
