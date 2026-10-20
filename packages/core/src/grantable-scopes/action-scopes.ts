import type { GrantScopeKind, PlatformAction } from "@work-shape/catalyst-asset-schemas";

/** The scope kinds a grant row can be written at, for some of the actions. */
export type ActionScopes = Partial<Record<PlatformAction, readonly GrantScopeKind[]>>;
