/** Rights over the instance itself: people, usage, audit, API access, models and releases. */
export const ADMINISTRATION_ACTIONS = [
  "users.manage",
  "usage.view",
  "audit.view",
  "api_access.manage",
  // Creating service principals, giving and taking their rights, enabling and disabling them.
  // Their keys stay with `api_access.manage`.
  "service_principals.manage",
  "agent_models.manage",
  "assets.release"
] as const;
