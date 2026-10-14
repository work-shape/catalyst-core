import { hostname } from "node:os";
import { createApiClient } from "@vivd-catalyst/api-client";
import { assertSafeApiKeyExchangeUrl, instanceFetch, toConfigApiError } from "./api";
import {
  type ConfigCommandOptions,
  formatCommandError,
  resolveWorkingDir,
  writeError,
  writeOutput
} from "./command-support";
import { credentialOrigin, removeCredential, saveCredential } from "./credentials";
import { readConfigCliEnv } from "./env";
import { MANIFEST_FILENAME, readManifest, resolveInstance } from "./working-copy";

/**
 * Logs in by a connect code: the instance gives a short code, the person confirms it in
 * Settings with the scopes and expiry the key gets, and this CLI collects the key with its own
 * long code and saves it. The key is never printed and never passes through a shell.
 */
export async function loginCommand(options: ConfigCommandOptions): Promise<number> {
  try {
    const url = await resolveInstanceUrl(options);
    assertSafeApiKeyExchangeUrl(url, "receive an API key");
    const sleep = options.sleep ?? defaultSleep;
    const client = createApiClient({
      baseUrl: url,
      fetchImpl: instanceFetch(options.fetchImpl)
    });
    const started = await call(() =>
      client.connect_codes.start({ body: { clientLabel: `catalyst CLI on ${hostname()}` } })
    );
    writeOutput(
      options,
      [
        `Open ${url}${started.confirmPath}`,
        `and confirm the code ${started.userCode} with the scopes this key may use.`,
        `Waiting for the confirmation until ${formatTime(started.expiresAt)}…`
      ].join("\n")
    );
    const deadline = Date.parse(started.expiresAt);
    while (Date.now() < deadline) {
      await sleep(started.intervalSeconds * 1000);
      const answer = await call(() =>
        client.connect_codes.redeem({ body: { deviceCode: started.deviceCode } })
      );
      if (answer.status === "pending") continue;
      const path = await saveCredential(readConfigCliEnv(options.env), url, {
        apiKey: answer.secret,
        keyId: answer.key.id,
        name: answer.key.name,
        expiresAt: answer.key.expiresAt,
        savedAt: new Date().toISOString()
      });
      writeOutput(
        options,
        [
          `Logged in to ${credentialOrigin(url)} with the key '${answer.key.name}' (${answer.key.keyPrefix}…).`,
          `It may: ${answer.key.scopes.join(", ")}, as far as your rights reach, until ${formatTime(answer.key.expiresAt)}.`,
          `Saved in ${path}. Revoke it in Settings, API keys.`
        ].join("\n")
      );
      return 0;
    }
    writeError(options, "The code expired before it was confirmed. Run 'catalyst login' again.");
    return 1;
  } catch (error) {
    writeError(options, formatCommandError(error));
    return 1;
  }
}

/** Forgets the saved key of the instance. Revoking it is the interface's, in Settings. */
export async function logoutCommand(options: ConfigCommandOptions): Promise<number> {
  try {
    const url = await resolveInstanceUrl(options);
    const removed = await removeCredential(readConfigCliEnv(options.env), url);
    writeOutput(
      options,
      removed
        ? `Removed the saved key of ${credentialOrigin(url)}. It stays valid until you revoke it in Settings, API keys.`
        : `No key is saved for ${credentialOrigin(url)}.`
    );
    return 0;
  } catch (error) {
    writeError(options, formatCommandError(error));
    return 1;
  }
}

/** An address given as it is, or an instance named in the working copy's manifest. */
async function resolveInstanceUrl(options: ConfigCommandOptions): Promise<string> {
  const requested = options.instance;
  if (requested !== undefined && /^https?:\/\//u.test(requested)) {
    return requested.replace(/\/+$/u, "");
  }
  try {
    return resolveInstance(await readManifest(resolveWorkingDir(options)), requested).url;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `No ${MANIFEST_FILENAME} here to name the instance. Pass --instance <https-url>.`
      );
    }
    throw error;
  }
}

async function call<Output>(request: () => Promise<Output>): Promise<Output> {
  try {
    return await request();
  } catch (error) {
    throw toConfigApiError(error);
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}
