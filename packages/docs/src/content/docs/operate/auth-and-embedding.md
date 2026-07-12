---
title: Auth And Embedding
description: Connect Vivd Catalyst to users in an existing customer application.
---

The embedded chat path should rely on the customer application as the login authority.

Vivd Catalyst receives a short-lived chat session token and maps it into a product-owned authenticated user.

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

## Machine API Access

Non-human clients are service principals, not product users. A service principal owns permissions and may have multiple independently revocable API keys. An API key is exchanged at `POST /api/auth/access-token` for a short-lived service access token; normal API calls use that access token and do not create a product-user record.

Set a stable, high-entropy `SERVICE_ACCESS_TOKEN_SECRET` of at least 32 characters on the API server to enable exchange. It signs short-lived service tokens, must match across replicas, and must remain stable across restarts. API keys themselves live hashed in the database; their plaintext value is shown only once at creation and must be stored in an operator or CI secret store.

Keep machine credentials separate from embedded-chat credentials. `CHAT_SERVER_CREDENTIAL` authorizes a trusted customer backend to issue human chat session tokens; it is not the long-term CLI authentication mechanism.

## Embed Surface

The embed surface should be small:

- load the chat shell
- request or receive a chat session token
- pass safe client config to the UI
- send chat requests to the dedicated chat backend

Customer application code should not need to know agent runtime, tool execution, or database internals.
