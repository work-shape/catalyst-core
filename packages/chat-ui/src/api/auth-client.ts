export interface AuthSession {
  session: {
    id: string;
    userId: string;
    expiresAt: string;
  };
  user: {
    id: string;
    email: string;
    name: string;
  };
}

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
  return (await response.json()) as AuthSession | null;
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
  const payload = await response.json().catch(() => undefined);
  return {
    ok: false,
    message: payload?.message ?? payload?.error?.message ?? "Sign in failed"
  };
}

export async function signOut(apiBaseUrl: string): Promise<void> {
  await fetch(authUrl(apiBaseUrl, "/sign-out"), {
    method: "POST",
    credentials: "include"
  });
}

function authUrl(apiBaseUrl: string, path: string): string {
  return `${apiBaseUrl.replace(/\/$/u, "")}/api/auth${path}`;
}
