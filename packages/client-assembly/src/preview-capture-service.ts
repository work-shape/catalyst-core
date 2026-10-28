import type { ClientInstanceEnv } from "./env";
export { createInstancePreviewCaptureClient } from "./registration";

/** No dotenv or database assembly: this process must receive only its isolated environment. */
export async function runClientInstancePreviewCaptureService(
  env: ClientInstanceEnv
): Promise<void> {
  const { startCaptureService } = await import("@work-shape/catalyst-preview-capture");
  const service = await startCaptureService(env);
  await new Promise<void>((resolve) => service.server.once("close", resolve));
}
