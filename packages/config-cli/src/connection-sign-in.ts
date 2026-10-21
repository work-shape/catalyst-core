import type { ConnectionDetail } from "@work-shape/catalyst-api-client";
import type { ConfigApi } from "./api";
import { writeError, writeOutput, type ConfigCommandOptions } from "./command-support";
import { openInBrowser } from "./open-browser";

// The shared OAuth sign-in of a Connection from the terminal (CS-4b5). The instance starts the
// sign-in and answers the address of the provider's page; the person opens it in the browser
// they are signed in to the instance with, and the provider sends that browser back to the
// instance. The CLI reads the Connection until its sign-in is in and prints the binding's state.
// It never sees a code, a state or a token.

export interface SignInOptions extends ConfigCommandOptions {
  /** Opens an address in the person's browser. Tests pass one that records it. */
  openUrl?: (address: string) => void;
}

/** How often the CLI reads the Connection while the browser signs in. */
const READ_EVERY_MS = 2_000;

/**
 * Starts the sign-in, opens or prints the provider's address, and waits until the Connection
 * is connected by a newer sign-in than before, or the sign-in session ends. Exit 0 connected,
 * 1 not completed.
 */
export async function connectConnection(
  api: ConfigApi,
  name: string,
  options: SignInOptions & { openBrowser: boolean }
): Promise<number> {
  const start = await api.change(
    (client, idempotencyKey) =>
      client.connections.oauth_start({ params: { name }, idempotencyKey }),
    "Run the command again: a new sign-in replaces one that was not completed."
  );
  // Read before the address is shown: no browser can have completed this sign-in yet.
  const before = await readDetail(api, name);
  writeError(
    options,
    [
      `Sign in to ${start.providerHost} for the Connection '${name}' in the browser you are signed in to the instance with:`,
      start.authorizationUrl,
      `Waiting until the sign-in is in (until ${start.expiresAt}). Ctrl+C stops waiting; the sign-in can still be completed.`
    ].join("\n")
  );
  if (options.openBrowser) (options.openUrl ?? openProviderPage)(start.authorizationUrl);
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const until = Date.parse(start.expiresAt);
  for (;;) {
    const detail = await readDetail(api, name);
    if (signedIn(detail, before)) {
      writeOutput(options, JSON.stringify({ connection: name, binding: detail.binding }, null, 2));
      return 0;
    }
    if (Date.now() >= until) {
      writeError(
        options,
        `The sign-in of '${name}' was not completed before it expired. Run the command again.`
      );
      return 1;
    }
    await sleep(READ_EVERY_MS);
  }
}

function readDetail(api: ConfigApi, name: string): Promise<ConnectionDetail> {
  return api.read((client) => client.connections.get({ params: { name } }));
}

/** Connected by a sign-in that was not in before the start. */
function signedIn(detail: ConnectionDetail, before: ConnectionDetail): boolean {
  const { binding } = detail;
  if (binding?.state !== "connected") return false;
  const earlier = before.binding;
  return earlier?.state !== "connected" || earlier.connectedAt !== binding.connectedAt;
}

/** Opens only an `https` address of the provider. It is printed either way. */
function openProviderPage(address: string): void {
  if (new URL(address).protocol === "https:") openInBrowser(address);
}
