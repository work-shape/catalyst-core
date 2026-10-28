import { createEnvironmentSecretResolver } from "@work-shape/catalyst-core";
import { readFile } from "node:fs/promises";

/** These are the only environment values consumed; prohibited credentials refuse startup. */
export async function captureEnvironment(env: Record<string, string | undefined>) {
  if (
    Object.entries(env).some(
      ([key, value]) =>
        value &&
        /DATABASE_URL|OBJECT.*(?:KEY|SECRET)|(?:AWS|S3|MODEL|OPENAI|ANTHROPIC).*KEY|(?:AUTH|SESSION|CONTENT).*SECRET|CONTENT_KEY/u.test(
          key
        )
    )
  )
    throw new Error("Capture environment contains another service's credentials");
  const secrets = createEnvironmentSecretResolver({
    env,
    readSecretFile: (path) => readFile(path, "utf8")
  });
  const token = await secrets.resolve("PREVIEW_CAPTURE_SERVICE_TOKEN");
  const apiOrigin = new URL(env.PREVIEW_CAPTURE_API_ORIGIN ?? "http://api:4100");
  const interfaceOrigin = new URL(
    env.PREVIEW_CAPTURE_INTERFACE_ORIGIN ?? "http://interface.invalid"
  );
  const slots = Number(env.PREVIEW_CAPTURE_CONCURRENCY ?? 2);
  if (!token || token.length < 32 || !Number.isInteger(slots) || slots < 1)
    throw new Error("Invalid capture environment");
  for (const origin of [apiOrigin, interfaceOrigin])
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error("Capture origins must be origins");
  return { token, apiOrigin: apiOrigin.origin, interfaceOrigin: interfaceOrigin.origin, slots };
}
