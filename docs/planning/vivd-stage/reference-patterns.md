# Reference Patterns

These are external patterns worth borrowing. They are not dependency decisions unless explicitly stated elsewhere.

## Less Is More

Reference: product and systems design discipline.

Borrow:

- Prefer an essential user and developer experience over a broad configurable surface.
- Hide complexity behind strong defaults, focused APIs, and deep modules.
- Expose only the fields, settings, UI controls, packages, and extension points that the workflow truly needs.
- Make every abstraction earn its place by hiding real complexity or enabling a concrete extension.
- Prefer one obvious path over multiple equivalent paths.

V1 shape:

```text
one chat spine
one config source
one auth adapter contract
one tool definition shape
one tool execution boundary
one persisted conversation model
```

Design review question:

```text
What can we hide, default, or remove so the essential workflow is clearer?
```

Do not copy blindly:

- Do not remove safety, auditability, retention, or permission checks just to reduce code.
- Do not hide important behavior behind magic defaults that future maintainers cannot inspect.

## Durable Execution

Reference: Temporal.

Borrow:

- Treat an agent run as a durable state machine, even before adding a workflow engine.
- Separate orchestration from fallible work: agent run orchestration owns state; tool execution is retryable work.
- Make cancellation, timeout, retry, and resume explicit in runtime contracts.
- Persist enough state that a run can explain what happened after a crash or deploy.

Do not copy in v1:

- Do not add Temporal as an operational dependency before the first vertical slice proves a need.
- Do not make workflow replay constraints leak into normal tool code.

Sources:

- https://docs.temporal.io/

## Authorization Modeling

Reference: OpenFGA / Zanzibar-style authorization.

Borrow:

- Phrase permission checks as: subject can perform action on object if condition/relation holds.
- Start with resource objects, not global roles.
- Model tool invocation as an action on a concrete object: conversation, agent, tool, file, knowledge source, or governance action.
- Test the authorization model with plain-language examples before encoding it.

V1 shape:

```text
authenticated user
  -> may invoke tool X
  -> for agent Y
  -> in conversation Z
  -> if agent release config includes tool X
  -> and user has required permission/group
  -> and tool policy is allow or approved
```

Do not copy in v1:

- Do not add OpenFGA as infrastructure before the permission model becomes too large for product-owned checks.

Sources:

- https://openfga.dev/docs/modeling/getting-started

## Events And Observability

References: OpenTelemetry semantic conventions and CloudEvents.

Borrow:

- Use stable event names and attribute names across runtime, tool, audit, and trace events.
- Separate observability traces from minimized audit events.
- Include common metadata consistently: event id, type, source, time, subject/resource id, actor id, correlation id, and data schema/version.
- Keep sensitive payloads out of event metadata by default.

V1 shape:

```text
agent.run.started
agent.run.completed
tool.call.requested
tool.call.approved
tool.call.completed
conversation.deleted
config.activated
```

Do not copy in v1:

- Do not force every internal event to be a literal CloudEvent if it adds ceremony.
- Do not build a full telemetry platform.

Sources:

- https://opentelemetry.io/docs/concepts/semantic-conventions/
- https://cloudevents.io/

## Idempotent Mutations

Reference: Stripe API.

Borrow:

- Use idempotency keys for mutating operations that clients or jobs may retry.
- Store the first result for a key and return the same result for retries.
- Compare request parameters on retry to prevent accidental key reuse.
- Avoid personal data in idempotency keys.

V1 candidates:

- customer-backed chat session creation
- message send / agent run start
- file upload finalization
- tool permission approval
- data deletion request
- deploy/publish operations where applicable

Do not copy blindly:

- Not every endpoint needs idempotency. Use it for retryable side effects.

Sources:

- https://docs.stripe.com/api/idempotent_requests

## Agent And Web Safety

References: OWASP LLM Top 10 and OWASP SSRF guidance.

Borrow:

- Treat tool inputs, retrieved content, documents, and web pages as untrusted instructions.
- Enforce least-privilege tools and avoid broad agent capabilities by default.
- Require explicit approval for high-impact tool calls.
- For future URL/file fetch, block private, loopback, link-local, and metadata-service targets.
- Limit redirects, file size, content type, runtime, and network access.
- Log/audit decisions without storing raw sensitive payloads.

Do not copy in v1:

- Do not build broad browser automation or web fetch before a concrete workflow requires it.

Sources:

- https://owasp.org/www-project-top-10-for-large-language-model-applications
- https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

## Fine-Grained Integration Permissions

References: GitHub fine-grained permissions and similar integration systems.

Borrow:

- Make each external tool operation describe the exact action it can perform.
- Prefer scoped credentials per integration/tool group.
- Show human-readable permissions before granting high-impact access.
- Keep OpenAPI/MCP tool exposure allowlisted, not "import everything".

Do not copy in v1:

- Do not build a broad app marketplace or runtime permission editor.

Sources:

- https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
