import { describe, expect, it } from "vitest";
import { createCapabilityBrand } from "@work-shape/catalyst-client-assembly";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { createTestConfig } from "./support/fixtures";

// A capability's page outside the instance shows the instance's name, accent colour and logo;
// the logo comes as bytes, read once from where the config points.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function configWith(ui: Record<string, unknown>, accentColor?: string) {
  const base = createTestConfig();
  return parseClientInstanceConfig({
    ...base,
    ui: {
      ...base.ui,
      ...ui,
      ...(accentColor ? { theme: { ...base.ui?.theme, accentColor } } : {})
    },
    infrastructure: {
      ...base.infrastructure,
      mail: {
        provider: "capture",
        appUrl: "https://chat.example.test",
        sender: { fromAddress: "noreply@example.test" }
      }
    }
  });
}

describe("the instance's brand for a capability", () => {
  it("names the instance, its accent colour and reads its logo once against the app address", async () => {
    const asked: string[] = [];
    const brand = createCapabilityBrand(
      configWith({ clientName: "Beispiel GmbH", logoUrl: "/brand/logo.png" }, "#0f766e"),
      {
        fetch: async (url) => {
          asked.push(String(url));
          return new Response(PNG, { status: 200 });
        }
      }
    );
    expect(brand.name).toBe("Beispiel GmbH");
    expect(brand.accentColor).toBe("#0f766e");
    await expect(brand.logo()).resolves.toEqual({ contentType: "image/png", content: PNG });
    await brand.logo();
    expect(asked).toEqual(["https://chat.example.test/brand/logo.png"]);
  });

  it("reads a logo at a path against the instance's address when the instance sends no mail", async () => {
    const base = createTestConfig();
    const asked: string[] = [];
    const brand = createCapabilityBrand(
      parseClientInstanceConfig({
        ...base,
        instance: { ...base.instance, publicUrl: "https://app.example.test" },
        ui: { ...base.ui, logoUrl: "/brand/logo.png" },
        infrastructure: { ...base.infrastructure, mail: undefined }
      }),
      {
        fetch: async (url) => {
          asked.push(String(url));
          return new Response(PNG, { status: 200 });
        }
      }
    );
    await expect(brand.logo()).resolves.toEqual({ contentType: "image/png", content: PNG });
    expect(asked).toEqual(["https://app.example.test/brand/logo.png"]);
  });

  it("has no logo where none is set or it is no image, and no colour that is not hex", async () => {
    expect(await createCapabilityBrand(configWith({ logoUrl: undefined })).logo()).toBeUndefined();
    const notAnImage = createCapabilityBrand(configWith({ logoUrl: "/brand/logo.svg" }), {
      fetch: async () => new Response("<svg/>", { status: 200 })
    });
    await expect(notAnImage.logo()).resolves.toBeUndefined();
    expect(createCapabilityBrand(configWith({}, "teal")).accentColor).toBeUndefined();
  });
});
