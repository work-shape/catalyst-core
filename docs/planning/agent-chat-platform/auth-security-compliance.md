# Auth, Security, And Compliance

The first workflow processes sensitive personal data. The architecture should treat audit, retention, authorization, provider region, and custom-code boundaries as product features rather than afterthoughts.

## Auth Model

Authentication should sit behind an `Auth Adapter` interface. The chat backend should not hardcode one identity provider or assume the customer application is the only possible source forever.

The auth adapter turns an incoming request into an authenticated product user:

```text
request/session token
  -> Auth Adapter
  -> Authenticated User
     - stable external user id
     - display label
     - roles/groups
     - permission references
     - client instance id
     - audit/correlation context
```

Use a product-owned internal `AuthenticatedUser` shape. Customer adapters translate customer identity claims into this internal model instead of leaking customer-specific auth structures across the platform.

Recommended v1 fields:

- internal user id or stable identity mapping id
- external user id from the customer identity source
- display label
- optional email
- roles/groups
- permission references
- client instance id
- auth source / adapter id
- request correlation id

The exact customer token can stay small and customer-specific. The platform should normalize it before authorization, conversation ownership, audit, and tool permission checks.

The product-owned user id is the canonical conversation owner. Auth-source-specific ids are stored as `User Identity Mapping` records so the same person can use standalone chat, embedded chat, or both without duplicating conversation history. A user may have no embedded customer-app identity mapping when that user only uses standalone chat.

Email may be stored on users and identity mappings, but email is not the durable account key. Use verified email as a linking hint or migration aid only when the source is trusted; explicit identity mappings remain the safe way to share context across auth paths.

Automatic linking by verified email is implemented behind `auth.identityLinking.byVerifiedEmail` (default `true`). On first login through a new auth source, the platform attaches the identity to an existing user only when the incoming claims carry a verified email, the email matches exactly one active user (via that user's verified identity emails or the superadmin-managed user email), and the match is unambiguous. Ambiguous matches never link; they create a separate user. Every automatic link is recorded as a `user.identity_linked` audit event. Superadmin identity mapping endpoints remain the manual fallback.

V1 auth adapters:

- **Development auth adapter**: test/local-only configured users for adapter and authorization tests. It must not expose a user-listing HTTP route or become the primary standalone development login path.
- **Customer-backed token adapter**: production adapter for embedded chat where the customer's application is the login authority.

Future auth adapters may support OIDC, customer-signed JWTs, SAML-backed gateways, or other customer identity patterns without changing the rest of the chat runtime.

## Auth Library Decision

Use different auth implementations for different auth paths, but keep one product-owned auth contract.

For v1 embedded chat, do not use a full login framework. The customer application remains the authentication authority and the chat backend verifies short-lived chat session tokens through the product-owned auth adapter. This keeps the customer integration small and avoids adding user/password/session concepts that the embedded path does not need.

For first-party standalone/control-plane production login, use **Better Auth** as the default auth library when that surface needs admin accounts, sessions, passwordless login, OAuth, 2FA, or user management.

Better Auth fits the planned stack because it is TypeScript-native, framework-agnostic, self-hosted/open-source, database-backed, and has plugins for admin and organization-style access control.

Implementation rules:

- Do not expose Better Auth user/session/plugin types as platform public types.
- Map Better Auth users/sessions into the product-owned `AuthenticatedUser` shape.
- Keep control-plane/admin auth separate from customer-user embedded chat auth.
- Keep Better Auth schema/migrations explicit in the normal application migration flow.
- Do not use Better Auth's organization/multi-tenant concepts to reintroduce managed multi-tenant SaaS assumptions.

The auth model has three initial paths:

1. **Development/local auth**
   - Used by low-level tests and local adapter debugging only.
   - Provides configured mock/dev users without depending on the customer's application.
   - Must be disabled or explicitly guarded in production.

2. **Standalone/control-plane login**
   - Used by the standalone chat UI during local development and standalone deployments.
   - Uses Better Auth email/password sessions in the same production-shaped path.
   - Local development creates representative users, such as a normal user and a superadmin, by seeding the auth database from release config or an explicit CLI.
   - Development seed credentials must be replaced or disabled in production.

3. **Customer-backed session token**
   - Used by embedded production chat.
   - The customer application remains the source of truth for login.
   - The widget asks the customer backend for a short-lived chat session token.
   - The chat backend verifies the token and maps claims to user identity, roles/groups, and permissions.

Recommended production flow:

```text
authenticated customer app session
  -> widget calls customer backend /api/chat-session
  -> customer backend verifies the current user
  -> customer backend requests or signs a short-lived chat token
  -> widget calls dedicated chat backend with the token
```

For the lowest-friction first customer integration, prefer a small customer backend endpoint that calls the dedicated chat backend with a server-to-server credential and receives a short-lived chat token. This avoids requiring the customer backend to implement JWT signing on day one while still keeping the customer app as the authentication authority.

Recommended v1 endpoint shape:

```text
POST customer-app /api/chat-session
  -> customer app verifies its own authenticated user
  -> customer app calls chat backend POST /auth/session-token
  -> chat backend returns a short-lived chat session token
  -> customer app returns token and expiry to the widget
```

Customer app to chat backend:

```json
{
  "externalUserId": "customer-user-123",
  "displayLabel": "Jane Doe",
  "email": "jane@example.com",
  "roles": ["employee"],
  "permissionRefs": ["payroll-reader"],
  "correlationId": "optional-request-id"
}
```

Chat backend to customer app:

```json
{
  "chatSessionToken": "short-lived-token",
  "expiresAt": "2026-06-05T12:00:00.000Z"
}
```

The customer app should not expose the server-to-server credential to the browser. The widget only receives the short-lived chat session token.

The token should contain only minimal claims:

- stable user id
- display label if needed
- roles/groups or permission references
- client instance identifier
- expiry
- audit/correlation id if useful

The token should not contain sensitive documents, payslip data, or long-lived credentials.

## User-Scoped Conversations

The chat should persist past conversations so a user can resume previous work within the configured retention window. A user should see only their own conversations by default.

Access rule:

```text
Authenticated User
  -> list conversations where owner_external_user_id matches
  -> optionally include shared/admin-visible conversations only when a role/permission allows it
```

Conversation ownership should be based on the stable user identity returned by the auth adapter, not on a browser-local id. If the customer's user id changes, that should be treated as an identity-mapping concern.

When a standalone identity and an embedded customer-app identity should share context, both identities should map to the same product-owned user id. Users without an embedded identity mapping remain standalone-only and should not be forced through the customer application.

Conversation persistence must be retention-aware because the workflow may contain sensitive personal data. The retention duration should be configurable per client instance and should apply to:

- conversation metadata
- messages
- model inputs/outputs
- tool call records
- generated document analysis outputs
- file references and derived text where applicable

Deletion should be implemented as a product behavior, not just a manual database operation. Retention jobs should be auditable.

The concrete retention duration must be decided with the customer/legal owner for the workflow. GDPR Article 5's storage limitation principle requires personal data to be kept no longer than necessary for the processing purpose; it does not provide a universal fixed retention period for this product.

## Governance And Data Deletion

The standalone surface should include a small control plane for governance. Governance access is separate from normal chat access.

In v1, governance means concrete product operations, not a full compliance suite:

- inspect client-instance config and retention status
- inspect minimized audit events
- delete one conversation or all conversations for a user where allowed
- expire retained data through scheduled retention jobs
- export/request data only where the client-instance policy permits it
- require a stronger role and explicit reason for sensitive admin/superadmin actions

Governance roles may include:

- **user**: can access their own conversations and request/delete their own data where allowed.
- **admin**: can inspect operational state and perform configured governance actions.
- **superadmin**: can perform sensitive data operations such as deleting user data, with stronger audit requirements.

The product should support data deletion workflows:

- delete one conversation
- delete all conversations for an authenticated user
- delete or expire related tool outputs and document analysis outputs
- delete file/object references where applicable
- preserve minimal audit records where legally/contractually required
- record who requested deletion, what was deleted, and when

User-initiated deletion should be supported where the customer/legal owner allows it. Admin/superadmin deletion should support governance and data-subject-right handling.

GDPR Article 17 provides a right to erasure in certain circumstances, but the right is not absolute. The product should provide deletion mechanisms; the customer/legal owner must decide when deletion is legally required, restricted, or overridden by another lawful retention obligation.

## Security Baseline

The planning baseline includes:

- client instance isolation
- short-lived user tokens
- auth adapter seams for customer-specific identity sources
- user-scoped conversation history
- governance roles and audited admin/superadmin data operations
- deletion workflows for conversations and related outputs
- per-user authorization for tools
- least-privilege access to customer systems
- prompt, completion, and tool-call traceability without full payloads in audit events by default
- configurable retention and deletion
- redaction or minimization where possible
- region/provider controls
- clear processor/subprocessor story
- human review requirements for high-impact outputs
- strong boundaries around custom code execution
