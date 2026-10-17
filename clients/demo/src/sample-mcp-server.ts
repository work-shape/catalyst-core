import { z } from "zod";
import {
  createSampleMcpServer,
  SAMPLE_MCP_KEY_NAME,
  SAMPLE_MCP_PORT,
  SampleMcpKeyError
} from "../sample-mcp/server.js";
import { readSampleMcpEnvironment } from "./env.js";

try {
  const environment = readSampleMcpEnvironment();
  const { oauthIssuerBase, oauthBrowserBase, oauthClientId, oauthRedirectUri } = environment;
  const server = createSampleMcpServer({
    ...(oauthIssuerBase === undefined
      ? {}
      : {
          oauth: {
            issuerBase: oauthIssuerBase,
            ...(oauthBrowserBase === undefined ? {} : { browserBase: oauthBrowserBase }),
            ...(oauthClientId === undefined || oauthRedirectUri === undefined
              ? {}
              : { registeredClient: { clientId: oauthClientId, redirectUri: oauthRedirectUri } })
          }
        }),
    key: await environment.secrets.resolve(SAMPLE_MCP_KEY_NAME),
    anchor: environment.anchor,
    accountingLastMonth: environment.accountingLastMonth,
    log: (line) => console.log(line)
  });
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .safeParse(environment.port ?? SAMPLE_MCP_PORT);
  const host = z
    .string()
    .min(1)
    .safeParse(environment.host ?? "0.0.0.0");
  if (!port.success || !host.success) throw new Error("PORT or HOST is invalid.");
  const address = await server.listen(port.data, host.data);
  console.log(`Sample MCP server listening on port ${address.port}.`);
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void server.close().catch(() => {
      console.error("The sample MCP server could not close.");
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
} catch (error: unknown) {
  // Both messages name the variable and never its value.
  const message =
    error instanceof SampleMcpKeyError ||
    (error instanceof Error && error.name === "SecretNotResolvedError")
      ? error.message
      : "The sample MCP server could not start. Check SAMPLE_DATA_ANCHOR, SAMPLE_ACCOUNTING_LAST_MONTH, SAMPLE_OAUTH_ISSUER_BASE, SAMPLE_OAUTH_BROWSER_BASE, SAMPLE_OAUTH_REDIRECT_URI, PORT and HOST.";
  console.error(message);
  process.exitCode = 1;
}
