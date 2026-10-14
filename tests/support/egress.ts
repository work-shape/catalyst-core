import { expect } from "vitest";
import { egressConfigSchema } from "@vivd-catalyst/config-schema";
import {
  createEgressChecker,
  type EgressAllowEntry,
  type EgressResolvedAddress
} from "@vivd-catalyst/connections";
import { AppError, type EgressTarget } from "@vivd-catalyst/core";

// What the tests of the egress checker share: a checker over a list and a resolver of fixed
// answers, and the one way a refusal is read.

export type Dns = Record<string, string[]>;

export function checkerOf(
  allow: Array<Partial<EgressAllowEntry> & { host: string }>,
  dns: Dns = {},
  further: {
    allowPublicHttps?: boolean;
    platformStore?: { host: string; port: number }[];
    platformStoreUnknown?: boolean;
    now?: () => number;
  } = {}
) {
  const asked: string[] = [];
  const checker = createEgressChecker({
    allow: egressConfigSchema.parse({
      allow: allow.map((entry) => ({ protocol: "https", port: 443, ...entry }))
    }).allow,
    resolve(host) {
      asked.push(host);
      const answers = dns[host];
      if (!answers) return Promise.reject(new Error("ENOTFOUND"));
      return Promise.resolve(
        answers.map((address): EgressResolvedAddress => ({
          address,
          family: address.includes(":") ? 6 : 4
        }))
      );
    },
    ...further
  });
  return { checker, asked };
}

export const https = (host: string, port = 443): EgressTarget => ({
  protocol: "https",
  host,
  port
});

export async function denied(work: Promise<unknown>): Promise<AppError> {
  const error: unknown = await work.then(
    () => undefined,
    (caught: unknown) => caught
  );
  if (!(error instanceof AppError)) throw new Error("Expected the target to be refused");
  expect(error.code).toBe("FORBIDDEN");
  expect(error.details).toMatchObject({ reason: "egress_denied" });
  return error;
}

/** A listed target whose name gave no address: refused, and not as `egress_denied`. */
export async function unresolved(work: Promise<unknown>): Promise<AppError> {
  const error: unknown = await work.then(
    () => undefined,
    (caught: unknown) => caught
  );
  if (!(error instanceof AppError)) throw new Error("Expected the target to be refused");
  expect(error.code).toBe("CONFLICT");
  expect(error.details).toMatchObject({ reason: "egress_unresolved" });
  return error;
}
