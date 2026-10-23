import { recordOf, type ApprovalCandidate } from "./connection-approval-model";
import type { CataloguePartOffer } from "./connection-catalogue-model";
import type { ConnectionCredentialMode } from "./connection-form-model";

// A catalogue part that signs in with OAuth (CAT-OAUTH-UI), without React: whose account it
// reads with, the steps of its install, and the permissions a sign-in asks for. The instance
// writes the scopes itself from the approved operations (CAT-OAUTH); these functions show the
// admin the same set before the approval, and write it the same way.
//
// The install's order: Prepare (mode, checklist, client id and secret), Verbinden (saves and
// sets the secret; nothing signs in yet), Review (Freigeben enables the ticked operations and
// so widens the scopes), then the sign-in with exactly those scopes: the shared account's, or
// for a personal part the admin's own, optional. A sign-in before the review would ask for the
// identity group alone and need a second one at once.

/** The group every OAuth part asks for: who signed in. */
export const IDENTITY_GROUP = "identity";

/** The part signs in at its provider: a client id and secret, then a sign-in. */
export function signsIn(part: Pick<CataloguePartOffer, "authScheme">): boolean {
  return part.authScheme === "oauth";
}

/** Whose accounts the part allows, and the one the install starts with. */
export function partModes(
  part: Pick<CataloguePartOffer, "credentialModes" | "defaultCredentialMode">
): {
  modes: ConnectionCredentialMode[];
  initial: ConnectionCredentialMode;
} {
  const modes: ConnectionCredentialMode[] =
    part.credentialModes === undefined || part.credentialModes.length === 0
      ? ["shared"]
      : [...part.credentialModes];
  const initial =
    part.defaultCredentialMode !== undefined && modes.includes(part.defaultCredentialMode)
      ? part.defaultCredentialMode
      : (modes[0] ?? "shared");
  return { modes, initial };
}

/**
 * The scopes a sign-in asks for once the named operations are enabled: the identity group's,
 * then those of each group with an enabled operation, in the part's order. As the instance
 * writes them.
 */
export function scopesFor(
  part: Pick<CataloguePartOffer, "groups" | "operations">,
  enabled: Iterable<string>
): string[] {
  const names = new Set(enabled);
  const groups = new Set([
    IDENTITY_GROUP,
    ...part.operations.flatMap((operation) =>
      names.has(operation.name) && operation.group !== undefined ? [operation.group] : []
    )
  ]);
  return [
    ...new Set(
      (part.groups ?? []).filter((group) => groups.has(group.id)).flatMap((group) => group.scopes)
    )
  ];
}

/** One group of the review: its operations, its scopes, and whether ticking it asks for more. */
export interface ReviewGroup {
  id: string;
  title: CataloguePartOffer["description"] | undefined;
  candidates: ApprovalCandidate[];
  scopes: string[];
  /**
   * A tool of the group is ticked, and the group is none the entry recommends: the next
   * sign-in asks for more access.
   */
  widens: boolean;
}

/**
 * The review's rows by group, in the part's order, with the operations no group names last.
 * A group with no operation, such as identity, has no rows and is left out.
 */
export function reviewGroups(
  part: Pick<CataloguePartOffer, "groups" | "operations">,
  candidates: readonly ApprovalCandidate[],
  selected: ReadonlySet<string>
): ReviewGroup[] {
  const groupOf = new Map(
    part.operations.map((operation) => [operation.name, operation.group] as const)
  );
  const recommended = new Set(
    part.operations.flatMap((operation) =>
      operation.recommended && operation.effect === "reading" && operation.group !== undefined
        ? [operation.group]
        : []
    )
  );
  const declared = part.groups ?? [];
  const known = new Set(declared.map((group) => group.id));
  const rows = (id: string | undefined) =>
    candidates.filter((candidate) => {
      const group = groupOf.get(candidate.name);
      return id === undefined ? group === undefined || !known.has(group) : group === id;
    });
  const grouped = declared.flatMap((group): ReviewGroup[] => {
    const inGroup = rows(group.id);
    if (inGroup.length === 0) return [];
    return [
      {
        id: group.id,
        title: group.title,
        candidates: inGroup,
        scopes: [...group.scopes],
        widens:
          group.id !== IDENTITY_GROUP &&
          !recommended.has(group.id) &&
          inGroup.some((candidate) => selected.has(candidate.name))
      }
    ];
  });
  const rest = rows(undefined);
  return rest.length === 0
    ? grouped
    : [...grouped, { id: "", title: undefined, candidates: rest, scopes: [], widens: false }];
}

/**
 * The definition with the scopes of its enabled operations, as the instance writes them. A
 * part without groups, or a definition without `settings.oauth`, stays as it is.
 */
export function withPartScopes(
  config: Record<string, unknown>,
  part: Pick<CataloguePartOffer, "groups" | "operations">
): Record<string, unknown> {
  if (part.groups === undefined) return config;
  const settings = recordOf(config.settings) ?? {};
  const oauth = recordOf(settings.oauth);
  if (oauth === undefined) return config;
  const operations = Array.isArray(config.operations) ? config.operations : [];
  const enabled = operations.flatMap((operation) => {
    const record = recordOf(operation) ?? {};
    return typeof record.name === "string" && record.enabled !== false ? [record.name] : [];
  });
  return {
    ...config,
    settings: { ...settings, oauth: { ...oauth, scopes: scopesFor(part, enabled) } }
  };
}

/** Where the install goes once a step is done. */
export type InstallStep =
  /** The operations to approve. */
  | "review"
  /** The shared account signs in, with the scopes of what was approved. */
  | "sign-in"
  /** Each person connects their own account; the admin may connect theirs now. */
  | "personal"
  /** Approved: the tools may be given to an agent. */
  | "approved"
  /** Nothing is left: the Connection's page opens. */
  | "done";

interface StepInput {
  part: Pick<CataloguePartOffer, "authScheme" | "operations">;
  mode: ConnectionCredentialMode;
}

/** After Verbinden: the review where the part has operations, else its sign-in. */
export function afterConnect({ part, mode }: StepInput): InstallStep {
  if (part.operations.length > 0) return "review";
  return signInStep({ part, mode }) ?? "done";
}

/** After Freigeben: the sign-in with the new scopes, else the give where it is offered. */
export function afterApprove(input: StepInput & { gives: boolean }): InstallStep {
  return signInStep(input) ?? (input.gives ? "approved" : "done");
}

/** After the shared account signed in: the give where it is offered. */
export function afterSignIn({ gives }: { gives: boolean }): InstallStep {
  return gives ? "approved" : "done";
}

function signInStep({ part, mode }: StepInput): "sign-in" | "personal" | undefined {
  if (!signsIn(part)) return undefined;
  return mode === "user" ? "personal" : "sign-in";
}
