---
title: Sign-in and embedding
description: Connect Workshape Catalyst to users in an existing customer application.
---

The embedded chat path should rely on the customer application as the login authority.

Workshape Catalyst receives a short-lived chat session token and maps it into a product-owned authenticated user.

## Recommended Embedded Flow

```text
authenticated customer app session
  -> widget asks customer backend for a chat session token
  -> customer backend verifies its own user
  -> customer backend calls chat backend token endpoint
  -> chat backend returns short-lived chat session token
  -> widget calls chat API with that token
```

The browser never receives the customer app's server-to-server credential.

## Browser Origins

Configure each embedding site's exact origin through the client assembly's `allowedOrigins`,
`CHAT_UI_ORIGIN`, or `auth.standalone.trustedOrigins`. The assembly merges these into one list
for Better Auth, CORS, and session-cookie origin checks. Development expands configured
loopback origins to `localhost`, `127.0.0.1`, and `[::1]` at the same port. Without configured
origins, same-origin requests still work; cross-origin requests receive no CORS grant.

Both the assembly and direct `createChatServer` callers accept `allowedOrigins` as a string
or an array of strings. Startup validates HTTP and HTTPS URLs, serializes their origins,
and removes duplicates. Wildcards, opaque origins, and other value types are rejected.

Cookie-authenticated writes require an allowed or same-server `Origin`. When `Origin` is
absent, only `Sec-Fetch-Site: same-origin` is accepted. GET, HEAD, and OPTIONS are exempt.
Bearer tokens, API-key exchange, and server credentials do not require this cookie check,
but browser callers still need their origin configured for CORS. Custom cookie auth adapters
must return `authenticationMethod: "session-cookie"` on the authenticated user.

An `Authorization` or `X-Server-Credential` header excludes standalone cookie and development
authentication, regardless of adapter order. Invalid explicit credentials never fall back to
a standalone session. Token-authenticated requests do not use the cookie origin check.
The cookie-only `/api/auth/*` endpoints, including session lookup and sign-out, reject
requests carrying either explicit credential header without accessing the session.

The API client omits cookies whenever `getToken` is configured, even if it currently returns
no token. Passing a widget `token` also selects this mode. Token-mode downloads and event
streams use the same transport; browser-managed downloads are disabled even if requested.
Without a token source, standalone requests, downloads, and event streams keep using cookies.
Every auth adapter must declare `credentialMode: "ambient"` or `"explicit"`. Only explicitly
marked credential adapters are consulted when an explicit credential header is present;
unmarked adapters are excluded too. Wrappers must preserve the wrapped adapter's mode.

## Token Claims

Keep token claims minimal:

- stable external user id
- display label
- optional verified email
- roles or permission refs
- client instance id
- expiry
- correlation id where useful

Do not put sensitive documents, tool outputs, long-lived credentials, or workflow payloads in the token.

## Identity Mapping

Conversation ownership should use a product-owned user identity.

External auth-source ids map to product users through user identity mappings. This allows standalone and embedded identities to share one conversation owner when linking is allowed and unambiguous.

Verified email can be a linking hint. It should not be the durable account key.

## Standalone And Control Plane Login

Standalone chat and control-plane routes may need their own login path.

The platform default is to keep that behind the same product-owned auth contract and use a self-hosted auth implementation internally. Do not expose auth-library user or session types across platform public boundaries.

## Two-Factor Sign-In

An account that signs in with a password can add a second factor: a six-digit code from an authenticator app such as Microsoft Authenticator, Google Authenticator or 1Password. There are no codes by e-mail or SMS. Sign-in through a company identity provider leaves the second factor to that provider.

A person sets it up under **Settings > You > Security** (German: **Einstellungen › Du › Sicherheit**): the password, a QR code with its key as text, the first code from the app, then ten backup codes, shown once, to copy or download. Each backup code signs in once in place of the app. The same page makes ten new backup codes, forgets every trusted browser, and turns the factor off, each with the password. To move to a new phone, a person turns it off and sets it up again.

At sign-in, an account with a factor asks for the code after the password; a password alone opens no session. **Trust this browser for 30 days** skips the code in that browser for 30 days from the moment the code was entered. A sign-in from the browser in that time does not extend it, so a browser is asked for the code at least every 30 days. Turning the factor off, an admin's reset and **Stop trusting all browsers** end the trust at once.

Wrong codes are limited: five per sign-in, and ten in a row lock the account's code step for 15 minutes. The codes also count toward the instance's sign-in limit per client address, `rateLimits.signInPerAddressPerMinute`.

### Requiring it

```yaml
auth:
  standalone:
    twoFactor:
      required: true
```

With `required: true`, every account with a password must set it up, existing accounts and running sessions included. Until a person has, the server answers every call except `me.get` with `403` and `details.reason: two_factor_setup_required`, and the interface shows only the screen **Set up two-factor sign-in**. The first valid code opens everything without a new sign-in. A personal API key of an owner without a factor is refused the same way; a service principal's key is not. A tool that signs in with a password, such as a script with `signInForSessionFetch`, cannot pass the code step: it uses an API key instead. Without the setting, setting it up stays each person's choice.

### Recovery and the admin reset

Someone who lost both phone and backup codes asks an admin. On **Instance > Users**, the person's page offers **Reset two-factor sign-in** to holders of `users.manage` (operation `users.two_factor.reset`); only a superadmin resets a superadmin, and nobody resets their own. Confirm outside the instance that it really is this person asking. The reset deletes the factor and the backup codes, forgets the trusted browsers and ends every session of the person; their next sign-in with the password reaches the setup screen.

The audit log records `user.two_factor_enabled`, `user.two_factor_disabled`, `user.two_factor_backup_codes_regenerated`, `user.two_factor_backup_code_used`, `user.two_factor_locked` and `user.two_factor_reset`, with the account and the sign-in source, never a key, an `otpauth://` address or a code.

### Storage

The factor lives in the instance database, table `two_factor`, one row per account. The sign-in library encrypts the key and the backup codes with a key derived from `BETTER_AUTH_SECRET`, which is never in the database. A trusted browser is a row in `verification` whose `identifier` starts with `trust-device-`, matched by a signed cookie. Deleting an account removes both.

### Operator runbook

- **The last admin lost the factor.** Nobody in the instance can reset it, so the operator does, after confirming who is asking. In one transaction on the instance database, with the account's sign-in id from `"user"` (by `email`):

  ```sql
  BEGIN;
  DELETE FROM two_factor WHERE user_id = '<id>';
  UPDATE "user" SET two_factor_enabled = false WHERE id = '<id>';
  DELETE FROM verification WHERE value = '<id>' AND identifier LIKE 'trust-device-%';
  DELETE FROM session WHERE "userId" = '<id>';
  COMMIT;
  ```

  The next sign-in with the password reaches the setup screen. Note it in the instance's own records; this change bypasses the audit log.

- **A restored backup** brings back the factors, backup codes and trusted browsers of its time. A person who changed phones or used backup codes since may hold codes that no longer match: reset them as above, or with the admin reset.
- **Changing `BETTER_AUTH_SECRET`** makes every stored factor unreadable and ends every session. Before a change, turn `required` off or plan to reset every account's factor; afterwards each person sets it up again.

## API Keys

An instance has two kinds of API keys. Both are exchanged at `POST /api/v1/auth/access-token` for a short-lived access token, and both need `SERVICE_ACCESS_TOKEN_SECRET` (below).

- **A personal key** acts as the person who issued it, narrowed to the scopes ticked when it was made, and never does more than that person may at the moment of a call. A person issues one under **Settings > You > API keys** (German: **Einstellungen › Du › API-Schlüssel**) or with `catalyst login`, which saves it for the CLI. A key lives at most a year, and no key issues another key. This needs the module `personalApiKeys`. See [Log in](/configure/cli/#log-in).
- **A service principal's key** is for automation such as CI or another system. It acts as the service principal and never as a person.

### Service Principals

Non-human clients are service principals, not product users. A service principal owns permissions and may have multiple independently revocable API keys. An API key is exchanged at `POST /api/v1/auth/access-token` for a short-lived service access token; normal API calls use that access token and do not create a product-user record.

Set a stable, high-entropy `SERVICE_ACCESS_TOKEN_SECRET` of at least 32 characters on the API server to enable exchange. It signs short-lived service tokens, must match across replicas, and must remain stable across restarts. API keys themselves live hashed in the database; their plaintext value is shown only once at creation and must be stored in an operator or CI secret store.

Keep machine credentials separate from embedded-chat credentials. `CHAT_SERVER_CREDENTIAL` authorizes a trusted customer backend to issue human chat session tokens at `POST /api/v1/instance/session-tokens` with the `x-server-credential` header; the CLI does not use it.

## Embed Surface

The embed surface should be small:

- load the chat shell
- request or receive a chat session token
- pass safe client config to the UI
- send chat requests to the dedicated chat backend

Customer application code should not need to know agent runtime, tool execution, or database internals.
