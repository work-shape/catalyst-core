import { z } from "zod";

/**
 * The sign-in library's mount. It is not a product operation: the library owns its paths and
 * payloads, and a session cookie is the only credential it accepts.
 */
export const AUTH_MOUNT_PATH = "/api/auth";

const authSessionSchema = z
  .object({
    session: z.object({ id: z.string(), userId: z.string(), expiresAt: z.string() }),
    user: z.object({ id: z.string(), email: z.string(), name: z.string() })
  })
  .nullable();

export type AuthSession = NonNullable<z.infer<typeof authSessionSchema>>;

const authFailureSchema = z.object({
  message: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional()
});

export interface AuthResult {
  ok: boolean;
  message?: string;
}

export async function getAuthSession(apiBaseUrl: string): Promise<AuthSession | null> {
  const response = await fetch(authUrl(apiBaseUrl, "/get-session"), {
    credentials: "include"
  });
  if (!response.ok) {
    return null;
  }
  return authSessionSchema.parse(await response.json());
}

export async function signInWithEmail(input: {
  apiBaseUrl: string;
  email: string;
  password: string;
}): Promise<AuthResult> {
  const response = await fetch(authUrl(input.apiBaseUrl, "/sign-in/email"), {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      rememberMe: true
    })
  });
  if (response.ok) {
    return { ok: true };
  }
  const failure = authFailureSchema.safeParse(await response.json().catch(() => undefined));
  return {
    ok: false,
    message: failure.data?.message ?? failure.data?.error?.message ?? "Sign in failed"
  };
}

export async function signOut(apiBaseUrl: string): Promise<void> {
  await fetch(authUrl(apiBaseUrl, "/sign-out"), {
    method: "POST",
    credentials: "include"
  });
}

function authUrl(apiBaseUrl: string, path: string): string {
  return `${apiBaseUrl.replace(/\/$/u, "")}${AUTH_MOUNT_PATH}${path}`;
}
