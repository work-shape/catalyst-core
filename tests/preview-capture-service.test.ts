import { DEFAULT_THEME_INPUTS } from "@work-shape/catalyst-ui/theme";
import { describe, expect, it } from "vitest";
import {
  captureEnvironment,
  captureInputSchema,
  forwardedPath
} from "@work-shape/catalyst-preview-capture";
import { createInstancePreviewCaptureClient } from "@work-shape/catalyst-client-assembly";
import { createEnvironmentSecretResolver } from "@work-shape/catalyst-core";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const token = "fixture-service-token-".repeat(3);
const origin = "https://interface.example";
const prefix = "/app-content/fset_00000000-0000-0000-0000-000000000000/proof.mac/";
describe("server capture boundaries", () => {
  it("starts dark and refuses a client with no service credential", async () => {
    const secrets = createEnvironmentSecretResolver({
      env: {},
      readSecretFile: async () => {
        throw new Error("No secret file");
      }
    });
    expect(await createInstancePreviewCaptureClient({}, secrets)).toBeUndefined();
    await expect(
      createInstancePreviewCaptureClient({ PREVIEW_CAPTURE_ENABLED: "true" }, secrets)
    ).rejects.toThrow();
  });
  it.each([
    "DATABASE_URL",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "OBJECT_STORAGE_KEY",
    "OPENAI_API_KEY",
    "BETTER_AUTH_SECRET",
    "CHAT_SESSION_TOKEN_SECRET",
    "APP_CONTENT_KEY"
  ])("refuses %s in the service environment", async (key) => {
    await expect(
      captureEnvironment({ PREVIEW_CAPTURE_SERVICE_TOKEN: token, [key]: "forbidden" })
    ).rejects.toThrow();
  });
  it("accepts only a fixed-origin GET of the capture's files or versioned kit", () => {
    expect(forwardedPath("GET", origin + prefix + "main.js", origin, prefix)).toBe(
      prefix + "main.js"
    );
    expect(
      forwardedPath("GET", origin + "/app-runtime/kit/1.0.0/fonts/inter/font.woff2", origin, prefix)
    ).toContain("font.woff2");
    for (const path of [
      "/unexpected/users",
      "/app-content/another/token/",
      prefix + "../private",
      prefix + "%2fprivate",
      "/app-runtime/kit/../private",
      "/app-runtime/kit/1.0.0/../../../unexpected",
      prefix + "?token=other"
    ])
      expect(forwardedPath("GET", origin + path, origin, prefix)).toBeUndefined();
    expect(forwardedPath("POST", origin + prefix, origin, prefix)).toBeUndefined();
    expect(
      forwardedPath("GET", "https://outside.example/pixel?secret=yes", origin, prefix)
    ).toBeUndefined();
    expect(forwardedPath("GET", "http://api:4100" + prefix, origin, prefix)).toBeUndefined();
  });
  it("accepts no person, run, grant or arbitrary URL in a service request", () => {
    const input = {
      themeColors: DEFAULT_THEME_INPUTS.light,
      contentPath: prefix,
      session: "capture:pcap_fixture",
      deadline: Date.now() + 1000,
      size: "desktop",
      theme: "light",
      locale: "en",
      number: 1
    };
    expect(captureInputSchema.safeParse(input).success).toBe(true);
    for (const field of ["person", "run", "grant", "url"])
      expect(captureInputSchema.safeParse({ ...input, [field]: "other" }).success).toBe(false);
  });
  it("ships only an isolated, credential-minimal opt-in Compose service", () => {
    const compose = parse(
      readFileSync("packages/deployment-kit/docker/preview-capture.compose.yml", "utf8")
    );
    const service = compose.services["preview-capture"];
    expect(service.profiles).toEqual(["preview-capture"]);
    expect(service.networks).toEqual(["preview-capture"]);
    expect(compose.networks["preview-capture"].internal).toBe(true);
    expect(Object.keys(compose.services)).toEqual(["api", "preview-capture"]);
    expect(Object.keys(service.environment).sort()).toEqual([
      "PREVIEW_CAPTURE_API_ORIGIN",
      "PREVIEW_CAPTURE_CONCURRENCY",
      "PREVIEW_CAPTURE_INTERFACE_ORIGIN",
      "PREVIEW_CAPTURE_SERVICE_TOKEN"
    ]);
    expect(service).toMatchObject({
      user: "10001:10001",
      read_only: true,
      cap_drop: ["ALL"],
      shm_size: "256m",
      pids_limit: 192,
      cpus: 1.5
    });
    expect(service.security_opt[0]).toBe("no-new-privileges:true");
    expect(service.volumes).toBeUndefined();
    expect(service.env_file).toBeUndefined();
  });
});
