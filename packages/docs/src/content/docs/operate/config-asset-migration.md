---
title: Migrating To Config Assets
description: Move an existing deployed instance from file-defined agents and skills to the database-backed asset store without changing its effective configuration.
---

Existing instances that still define agents and skills in files must migrate when they upgrade to a build with the config asset store. The goal of the migration is **config parity**: after the deploy and first push, the instance behaves exactly as it did before.

## Steps per instance

1. **Prepare the working copy.** In the instance's deployment repo, keep the existing `agents/*.agent.yaml` and `skills/*/SKILL.md` files where they are — they become the CLI working copy. Add a `catalyst.yaml` manifest with the instance URL, the previous `defaultAgentName`, and the asset globs.
2. **Prepare server authentication.** Set a new stable `SERVICE_ACCESS_TOKEN_SECRET` of at least 32 characters in the API environment. Retain `CHAT_SERVER_CREDENTIAL` / `CHAT_SESSION_TOKEN_SECRET` when the deployment issues embedded chat sessions; those values serve a separate human-session flow.
3. **Trim the release config.** Remove `defaultAgentName`, `agentFiles`, `skillFiles` (and any inline `agents`/`skills`) from `app.yaml`. Add the `administration.agentConfiguration` block to choose which fields admins may edit interactively.
4. **Deploy the bridge build first.** Run its committed database migrations, then start the API/UI build that accepts both API-key exchange and the legacy CLI session-token path. The instance starts with zero assets and the chat UI shows "not configured" — deploy and push back-to-back to keep this window short.
5. **Create CLI access.** Sign in as a superadmin and use **Administration → API Access** to create a `Catalyst CLI` service principal with `config_assets.read` and `config_assets.release`. Create a key restricted to `config_assets:read` and `config_assets:release`, copy its one-time secret, and set it as `CATALYST_API_KEY` only in the operator environment or CI secret store.
6. **Push the assets with the new CLI.** `catalyst config push --force --dir <working copy> --instance <url>`. `--force` is required only for this first push (there is no pulled asset baseline yet).
7. **Verify parity.** `catalyst config diff` must report no differences. Then confirm in the chat UI that the agent list, welcome content, and a test conversation behave as before. The revision history in the admin Config tab should show one `create` revision per asset attributed to the service principal and credential.

## Rollback

The previous image ignores the new tables and still reads its file config, so rolling back the deployment fully restores the old behavior. The pushed assets remain in the database for the next attempt.

## Bridge rollout and compatibility

Roll out in this order: database migrations; API/UI bridge build with `SERVICE_ACCESS_TOKEN_SECRET`; service principal and API-key creation; new CLI plus `CATALYST_API_KEY`; config push and verification. Do not distribute an API key before the exchange endpoint is deployed.

During the one-release bridge window:

- Old CLI + new server continues to work while the legacy session-token route and server credential remain enabled.
- New CLI + old server can read through the deprecated `CATALYST_SERVER_CREDENTIAL` / `CHAT_SERVER_CREDENTIAL` fallback, but push requires a server advertising per-asset conflict support. Upgrade the server first. An explicitly configured API key takes precedence and exchange failures do not silently downgrade.
- New CLI + new server uses API-key exchange.

Keep the legacy route and `CATALYST_SERVER_CREDENTIAL` available until every CLI runner has moved to API keys and the compatibility release has elapsed. Removing CLI fallback later does not imply removing `CHAT_SERVER_CREDENTIAL` from deployments that still issue embedded human chat sessions.

## Existing CLI working copies

After upgrading the CLI, pull before editing an existing working copy. Old state files containing only `lastPulledVersion` cannot guard individual assets. Commit or stash local edits before pulling, since it overwrites the working copy.

A push merges only locally changed assets and rejects the whole batch if any touched asset changed on the instance. The conflict report identifies the assets, their last actor and operation, and a `pull --only` command for recovery. Unchanged local assets preserve instance edits. Deletion still requires `--prune`; deliberate overwrites require `--force`. See [Config Assets](/configure/config-assets/) for the complete workflow.
