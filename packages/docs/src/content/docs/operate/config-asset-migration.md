---
title: Migrating To Config Assets
description: Move an existing deployed instance from file-defined agents and skills to the database-backed asset store without changing its effective configuration.
---

Existing instances that still define agents and skills in files must migrate when they upgrade to a build with the config asset store. The goal of the migration is **config parity**: after the deploy and first push, the instance behaves exactly as it did before.

## Steps per instance

1. **Prepare the working copy.** In the instance's deployment repo, keep the existing `agents/*.agent.yaml` and `skills/*/SKILL.md` files where they are — they become the CLI working copy. Add a `catalyst.yaml` manifest with the instance URL, the previous `defaultAgentName`, and the asset globs.
2. **Trim the release config.** Remove `defaultAgentName`, `agentFiles`, `skillFiles` (and any inline `agents`/`skills`) from `app.yaml`. Add the `administration.agentConfiguration` block to choose which fields admins may edit interactively. Ensure `auth.sessionToken` is configured and `CHAT_SERVER_CREDENTIAL` / `CHAT_SESSION_TOKEN_SECRET` are set in the environment.
3. **Deploy the new build.** Database migrations run at boot. The instance starts with zero assets and the chat UI shows "not configured" — deploy and push back-to-back to keep this window short.
4. **Push the assets.** `catalyst config push --force --dir <working copy> --instance <url>` with the instance's `CATALYST_SERVER_CREDENTIAL`. `--force` is required only for this first push (there is no pulled version yet).
5. **Verify parity.** `catalyst config diff` must report no differences. Then confirm in the chat UI that the agent list, welcome content, and a test conversation behave as before. The revision history in the admin Config tab should show one `create` revision per asset attributed to the CLI service principal.

## Rollback

The previous image ignores the new tables and still reads its file config, so rolling back the deployment fully restores the old behavior. The pushed assets remain in the database for the next attempt.

## Upgrading CLI permissions later

A service principal's permissions are captured into its product-user record on first authentication and do not refresh from later token claims. If a future platform upgrade requires new CLI permissions (as the introduction of `config_assets.release` did), delete the stored `catalyst-cli` product user (or grant the permission explicitly) so the next push recreates it with current grants.
