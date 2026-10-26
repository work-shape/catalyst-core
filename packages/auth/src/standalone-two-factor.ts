import { AsyncLocalStorage } from "node:async_hooks";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
  sessionMiddleware
} from "better-auth/api";
import { symmetricDecrypt } from "better-auth/crypto";
import { twoFactor } from "better-auth/plugins/two-factor";

/**
 * How long a browser trusted at the code step skips the code: counted from the moment the code
 * was entered there, never renewed by a later sign-in (TWO-FACTOR-1, Felix 2026-10-26).
 */
export const TRUSTED_BROWSER_DAYS = 30;
const TRUSTED_BROWSER_SECONDS = TRUSTED_BROWSER_DAYS * 24 * 60 * 60;

/** The library's names, which its rows and cookies carry. */
export const TRUST_DEVICE_IDENTIFIER_PREFIX = "trust-device-";
const TRUST_DEVICE_COOKIE = "trust_device";
const TWO_FACTOR_COOKIE = "two_factor";
const TWO_FACTOR_MODEL = "twoFactor";

/** What the sign-in library did with a person's second factor, for the audit of the server. */
export type StandaloneTwoFactorEventType =
  "enabled" | "disabled" | "backup_codes_regenerated" | "backup_code_used" | "locked";

export interface StandaloneTwoFactorEvent {
  type: StandaloneTwoFactorEventType;
  /** The person's id in the sign-in library, the `externalUserId` of their password sign-in. */
  authUserId: string;
  /** `backup_code_used` only: how many backup codes are left. */
  backupCodesLeft?: number;
}

/**
 * The routes of the library's plugin that this instance does not serve. Codes by e-mail or SMS
 * add no factor beside a password that is reset by e-mail (Felix). Reading the address of a set
 * up factor again would show its secret outside the one answer of its setup.
 */
const REFUSED_PATHS = new Set([
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
  "/two-factor/get-totp-uri"
]);

/** The path of "forget every trusted browser" in Settings > You. */
export const FORGET_TRUSTED_BROWSERS_PATH = "/two-factor/forget-trusted-browsers";

interface TwoFactorSubject {
  authUserId: string;
  /** Whether the call reached the library with a session, not with a sign-in challenge. */
  signedIn: boolean;
  enabled: boolean;
  lockedUntil?: Date | undefined;
}

/** What one call to the library learns on its way in and hands out at its end. */
interface TwoFactorRequestState {
  /** The expiry of the trust row a password sign-in presents. A renewal of that row keeps it. */
  trustExpiresAt?: Date;
  subject?: TwoFactorSubject;
  events: StandaloneTwoFactorEvent[];
  /** Lets the next code check of the same person run. */
  release?: () => void;
}

const requestState = new AsyncLocalStorage<TwoFactorRequestState>();

/** Runs one call to the library and returns what it did with a second factor beside its answer. */
export async function withTwoFactorEvents(
  call: () => Promise<Response>
): Promise<{ response: Response; events: StandaloneTwoFactorEvent[] }> {
  const state: TwoFactorRequestState = { events: [] };
  try {
    const response = await requestState.run(state, call);
    return { response, events: state.events };
  } finally {
    state.release?.();
  }
}

/** The routes that check a code against a person's failure count and lock. */
const CODE_CHECK_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);

/** The code check of each person running now, and those waiting behind it. */
const codeChecks = new Map<string, Promise<void>>();

/**
 * One code check at a time per person in this process. The library reads the lock before it
 * checks a code and writes it after the tenth failure, so checks sent side by side over several
 * sign-in challenges would all pass the lock before any failure is written. In turn, the
 * eleventh check finds the lock. Returns the release.
 */
async function serializeCodeCheck(authUserId: string): Promise<() => void> {
  const previous = codeChecks.get(authUserId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  codeChecks.set(authUserId, tail);
  await previous;
  return () => {
    release();
    if (codeChecks.get(authUserId) === tail) {
      codeChecks.delete(authUserId);
    }
  };
}

/**
 * The verification rows' create hook. When the library renews a trusted browser at a password
 * sign-in it deletes the row the cookie names and writes a new one 30 days from now; the new row
 * keeps the expiry of the old one, so the code is asked again 30 days after it was entered.
 */
export function keepTrustedBrowserExpiry(data: {
  identifier: string;
  expiresAt: Date;
}): { data: { expiresAt: Date } } | undefined {
  const trustExpiresAt = requestState.getStore()?.trustExpiresAt;
  if (!data.identifier.startsWith(TRUST_DEVICE_IDENTIFIER_PREFIX) || !trustExpiresAt) {
    return undefined;
  }
  return trustExpiresAt < data.expiresAt ? { data: { expiresAt: trustExpiresAt } } : undefined;
}

// The context the library hands a hook or an endpoint. Its own types are not exported in a form
// a plugin outside the library can name, so this reads only what it uses.
type AuthHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];
type DatabaseAdapter = AuthHookContext["context"]["adapter"];

interface TwoFactorRow {
  id: string;
  userId: string;
  backupCodes: string;
  verified?: boolean | null;
  lockedUntil?: Date | string | null;
}

/** The library's `twoFactor` plugin as this instance configures it, with the guard beside it. */
export function standaloneTwoFactorPlugins(options: {
  issuer: string;
  deleteTrustedBrowsers(authUserId: string): Promise<void>;
}): BetterAuthPlugin[] {
  return [
    twoFactor({
      issuer: options.issuer,
      // 6 digits, 30 seconds; 10 backup codes, encrypted with a key derived from the auth secret.
      trustDeviceMaxAge: TRUSTED_BROWSER_SECONDS
    }),
    twoFactorGuard(options.deleteTrustedBrowsers)
  ];
}

function twoFactorGuard(deleteTrustedBrowsers: (authUserId: string) => Promise<void>) {
  return {
    id: "catalyst-two-factor-guard",
    endpoints: {
      forgetTrustedBrowsers: createAuthEndpoint(
        FORGET_TRUSTED_BROWSERS_PATH,
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          await deleteTrustedBrowsers(ctx.context.session.user.id);
          const cookie = ctx.context.createAuthCookie(TRUST_DEVICE_COOKIE);
          ctx.setCookie(cookie.name, "", { ...cookie.attributes, maxAge: 0 });
          return ctx.json({ status: true });
        }
      )
    },
    hooks: {
      before: [
        {
          matcher: (context: { path?: string }) => context.path === "/sign-in/email",
          handler: createAuthMiddleware(async (ctx) => {
            await rememberTrustExpiry(ctx);
          })
        },
        {
          matcher: (context: { path?: string }) =>
            context.path?.startsWith("/two-factor/") === true,
          handler: createAuthMiddleware(async (ctx) => {
            if (REFUSED_PATHS.has(ctx.path)) {
              throw new APIError("NOT_FOUND", { message: "Not found" });
            }
            if (ctx.path === FORGET_TRUSTED_BROWSERS_PATH) {
              return;
            }
            const subject = await twoFactorSubject(ctx);
            const state = requestState.getStore();
            if (state && subject) {
              state.subject = subject;
            }
            if (state && subject && CODE_CHECK_PATHS.has(ctx.path)) {
              state.release = await serializeCodeCheck(subject.authUserId);
              // Read again once it is this call's turn: the call before may have locked it.
              const row = await findTwoFactorRow(ctx.context.adapter, subject.authUserId);
              subject.lockedUntil = row?.lockedUntil ? new Date(row.lockedUntil) : undefined;
            }
            if (ctx.path === "/two-factor/enable" && subject) {
              await guardEnable(ctx.context.adapter, subject);
            }
            // A backup code is for the sign-in step only. With a session it would only spend
            // the person's codes.
            if (ctx.path === "/two-factor/verify-backup-code" && subject?.signedIn) {
              throw new APIError("BAD_REQUEST", {
                message: "A backup code is used at sign-in only",
                code: "BACKUP_CODE_AT_SIGN_IN_ONLY"
              });
            }
          })
        }
      ],
      after: [
        {
          matcher: (context: { path?: string }) =>
            context.path?.startsWith("/two-factor/") === true,
          handler: createAuthMiddleware(async (ctx) => {
            const state = requestState.getStore();
            const subject = state?.subject;
            if (!state || !subject) {
              return;
            }
            const succeeded = !isAPIError(ctx.context.returned);
            const event = await twoFactorEventOf(ctx, subject, succeeded, deleteTrustedBrowsers);
            if (event) {
              state.events.push(event);
            }
          })
        }
      ]
    }
  } satisfies BetterAuthPlugin;
}

/**
 * `/two-factor/enable` on an account with a factor would store a new secret as verified without
 * a code from it, so it is refused there. Without one, a row left from an earlier setup goes
 * first, so the new secret starts unverified and only its first valid code turns it on.
 */
async function guardEnable(adapter: DatabaseAdapter, subject: TwoFactorSubject): Promise<void> {
  if (subject.enabled) {
    throw new APIError("FORBIDDEN", {
      message:
        "Two-factor sign-in is already set up. Turn it off with your password, then set it up again.",
      code: "TWO_FACTOR_ALREADY_ENABLED"
    });
  }
  await adapter.deleteMany({
    model: TWO_FACTOR_MODEL,
    where: [{ field: "userId", value: subject.authUserId }]
  });
}

/** Who a call to a `/two-factor/` route is about, as the library itself decides it. */
async function twoFactorSubject(ctx: AuthHookContext): Promise<TwoFactorSubject | undefined> {
  const session = await getSessionFromCtx(ctx);
  let authUserId: string | undefined = session?.user.id;
  if (!authUserId) {
    const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE);
    const challenge = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
    const verification = challenge
      ? await ctx.context.internalAdapter.findVerificationValue(challenge)
      : null;
    authUserId = verification?.value;
  }
  if (!authUserId) {
    return undefined;
  }
  const user: object | null = await ctx.context.internalAdapter.findUserById(authUserId);
  if (!user) {
    return undefined;
  }
  const row = await findTwoFactorRow(ctx.context.adapter, authUserId);
  const lockedUntil = row?.lockedUntil ? new Date(row.lockedUntil) : undefined;
  return {
    authUserId,
    signedIn: Boolean(session),
    enabled: "twoFactorEnabled" in user && user.twoFactorEnabled === true,
    ...(lockedUntil ? { lockedUntil } : {})
  };
}

async function twoFactorEventOf(
  ctx: AuthHookContext,
  subject: TwoFactorSubject,
  succeeded: boolean,
  deleteTrustedBrowsers: (authUserId: string) => Promise<void>
): Promise<StandaloneTwoFactorEvent | undefined> {
  const { authUserId } = subject;
  switch (ctx.path) {
    case "/two-factor/verify-totp":
      if (!succeeded) {
        return lockEventOf(ctx.context.adapter, subject);
      }
      // A valid code turns on a factor only where none was on: the first code of a setup.
      if (subject.enabled) {
        return undefined;
      }
      // A browser trusted before must not skip the code of the new factor.
      await deleteTrustedBrowsers(authUserId);
      await endOtherSessions(ctx, authUserId);
      return { type: "enabled", authUserId };
    case "/two-factor/verify-backup-code": {
      if (!succeeded) {
        return lockEventOf(ctx.context.adapter, subject);
      }
      const left = await backupCodesLeft(ctx, authUserId);
      return {
        type: "backup_code_used",
        authUserId,
        ...(left === undefined ? {} : { backupCodesLeft: left })
      };
    }
    case "/two-factor/disable":
      if (!succeeded) {
        return undefined;
      }
      // The library deletes only the trust row of the browser that turned the factor off.
      await deleteTrustedBrowsers(authUserId);
      return { type: "disabled", authUserId };
    case "/two-factor/generate-backup-codes":
      return succeeded ? { type: "backup_codes_regenerated", authUserId } : undefined;
    default:
      return undefined;
  }
}

/**
 * The first code of a setup turns on the factor for the whole account. Every session opened
 * with the password alone before it ends here, so only the session that entered the code (the
 * library has just replaced it) carries on without a new sign-in.
 */
async function endOtherSessions(ctx: AuthHookContext, authUserId: string): Promise<void> {
  const kept = ctx.context.newSession?.session.token;
  const sessions = await ctx.context.internalAdapter.listSessions(authUserId);
  const ended = sessions.map((session) => session.token).filter((token) => token !== kept);
  if (ended.length > 0) {
    await ctx.context.internalAdapter.deleteSessions(ended);
  }
}

/** `locked` once, by the failed code that started the lock. */
async function lockEventOf(
  adapter: DatabaseAdapter,
  subject: TwoFactorSubject
): Promise<StandaloneTwoFactorEvent | undefined> {
  const now = Date.now();
  if (subject.lockedUntil && subject.lockedUntil.getTime() > now) {
    return undefined;
  }
  const row = await findTwoFactorRow(adapter, subject.authUserId);
  const lockedUntil = row?.lockedUntil ? new Date(row.lockedUntil).getTime() : 0;
  return lockedUntil > now ? { type: "locked", authUserId: subject.authUserId } : undefined;
}

async function backupCodesLeft(
  ctx: AuthHookContext,
  authUserId: string
): Promise<number | undefined> {
  const row = await findTwoFactorRow(ctx.context.adapter, authUserId);
  if (!row) {
    return undefined;
  }
  try {
    const codes: unknown = JSON.parse(
      await symmetricDecrypt({ key: ctx.context.secretConfig, data: row.backupCodes })
    );
    return Array.isArray(codes) ? codes.length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Before a password sign-in: the expiry of the trust row the browser's signed cookie names. The
 * library checks the cookie and the row itself; this only keeps the expiry for its renewal.
 */
async function rememberTrustExpiry(ctx: AuthHookContext): Promise<void> {
  const state = requestState.getStore();
  if (!state) {
    return;
  }
  const cookie = ctx.context.createAuthCookie(TRUST_DEVICE_COOKIE);
  const value = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  const identifier = value ? value.split("!")[1] : undefined;
  if (!identifier?.startsWith(TRUST_DEVICE_IDENTIFIER_PREFIX)) {
    return;
  }
  const row = await ctx.context.internalAdapter.findVerificationValue(identifier);
  if (row) {
    state.trustExpiresAt = new Date(row.expiresAt);
  }
}

async function findTwoFactorRow(
  adapter: DatabaseAdapter,
  authUserId: string
): Promise<TwoFactorRow | null> {
  return adapter.findOne<TwoFactorRow>({
    model: TWO_FACTOR_MODEL,
    where: [{ field: "userId", value: authUserId }]
  });
}
