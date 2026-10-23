import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { generateTestSecret } from "./test-connector";
const accountEmail = "outside-account@example.test";

export async function createPersonalOAuthProvider() {
  let base = "",
    exchanges = 0,
    ttl = 3600,
    refuseRefresh = false;
  let responseBody: unknown = { ok: true };
  let responseStatus = 200;
  let beforeExchange: (() => Promise<void>) | undefined;
  const clientSecret = generateTestSecret(),
    secrets: string[] = [],
    headers: string[] = [],
    refreshes: string[] = [],
    revocations: string[] = [];
  const codes = new Map<string, { person: string; challenge: string; redirect: string }>();
  const refreshTokens = new Map<string, string>(),
    lastAccess = new Map<string, string>();
  const json = (response: ServerResponse, body: unknown, status = 200) =>
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  function issue(person: string) {
    const access = `access-${randomUUID()}`,
      refresh = `refresh-${randomUUID()}`;
    lastAccess.set(person, access);
    refreshTokens.set(refresh, person);
    secrets.push(access, refresh);
    const claims =
      person === "email" ? { email: accountEmail } : { preferred_username: `Account ${person}` };
    const id = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.display-only`;
    secrets.push(id);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: ttl,
      scope: "openid email sample.read",
      id_token: id
    };
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", base);
    if (url.pathname === "/authorize") {
      const code = randomUUID();
      codes.set(code, {
        person: url.searchParams.get("person") ?? "unknown",
        challenge: url.searchParams.get("code_challenge") ?? "",
        redirect: url.searchParams.get("redirect_uri") ?? ""
      });
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: back.href }).end();
      return;
    }
    if (url.pathname === "/personal-api/who") {
      headers.push(request.headers.authorization ?? "");
      json(response, responseBody, responseStatus);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    if (form.get("client_secret") !== clientSecret) {
      json(response, { error: "invalid_client" }, 401);
      return;
    }
    if (url.pathname === "/revoke") {
      revocations.push(refreshTokens.get(form.get("token") ?? "") ?? "unknown");
      json(response, {});
      return;
    }
    if (form.get("grant_type") === "refresh_token") {
      const person = refreshTokens.get(form.get("refresh_token") ?? "");
      if (!person || refuseRefresh) {
        json(response, { error: "invalid_grant" }, 400);
        return;
      }
      refreshes.push(person);
      refreshTokens.delete(form.get("refresh_token") ?? "");
      json(response, issue(person));
      return;
    }
    const code = codes.get(form.get("code") ?? "");
    codes.delete(form.get("code") ?? "");
    const challenge = createHash("sha256")
      .update(form.get("code_verifier") ?? "")
      .digest("base64url");
    if (!code || code.challenge !== challenge || code.redirect !== form.get("redirect_uri")) {
      json(response, { error: "invalid_grant" }, 400);
      return;
    }
    await beforeExchange?.();
    exchanges += 1;
    json(response, issue(code.person));
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => json(response, {}, 500));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    clientSecret,
    secrets,
    headers,
    refreshes,
    revocations,
    lastAccess,
    get responseBody() {
      return responseBody;
    },
    set responseBody(value: unknown) {
      responseBody = value;
    },
    get responseStatus() {
      return responseStatus;
    },
    set responseStatus(value: number) {
      responseStatus = value;
    },
    get beforeExchange() {
      return beforeExchange;
    },
    set beforeExchange(value: (() => Promise<void>) | undefined) {
      beforeExchange = value;
    },
    get refuseRefresh() {
      return refuseRefresh;
    },
    set refuseRefresh(value: boolean) {
      refuseRefresh = value;
    },
    get exchanges() {
      return exchanges;
    },
    get ttl() {
      return ttl;
    },
    set ttl(value: number) {
      ttl = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}
