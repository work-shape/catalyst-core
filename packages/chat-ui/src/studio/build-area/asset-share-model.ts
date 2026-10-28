import { listAll, type ApiClient } from "@work-shape/catalyst-api-client";
import type { BuildWorkspace } from "../../shared/build-rights";
import type { AssetOwner } from "./asset-place";

// "Teilen mit…" (SHARE-1): what the dialog offers and decides, apart from how it looks. The
// instance plans every move itself (`assets.move_check`); this only picks the rungs to offer and
// reads the answer.

/** What `assets.move_check` answers: what moves, what breaks, who reads and edits it after. */
export type AssetShareCheck = Awaited<ReturnType<ApiClient["assets"]["move_check"]>>;

/**
 * How a move came out: made at once, or waiting as a request for whoever holds the right at
 * the target. A call an operation policy holds for approval waits too.
 */
export interface AssetShareResult {
  status: AssetMoveOutput["status"];
}

/** What `assets.move` answers once the instance ran it. */
type AssetMoveOutput = Extract<
  Awaited<ReturnType<ApiClient["assets"]["move"]>>,
  { status: "done" }
>["output"];

/** The asset that is shared, as the page or the chooser knows it. */
export interface AssetShareSubject {
  kind: string;
  name: string;
  title: string;
  /** The id the page read: another asset of the name since is refused as a conflict. */
  id?: string;
  owner: AssetOwner;
}

/** A rung above the asset: a team the reader belongs to, or Alle. */
export type AssetShareTarget =
  { kind: "instance" } | { kind: "workspace"; workspaceId: string; name: string };

/** How the dialog asks the instance. Tests hand it a source of their own. */
export interface AssetShareSource {
  check(subject: AssetShareSubject, to: AssetShareTarget): Promise<AssetShareCheck>;
  move(
    subject: AssetShareSubject,
    to: AssetShareTarget,
    acceptBreaks: boolean
  ): Promise<AssetShareResult>;
  /**
   * The reader's own workspaces: the Personal one and every team they are a member of, whatever
   * rights they hold in it. Studio's list names only a workspace where the reader holds a right
   * on its assets, yet the instance lets them share into any team they belong to, and files a
   * request where they lack the right there. Without it the dialog offers what the page knows.
   */
  memberships?(): Promise<readonly BuildWorkspace[]>;
}

/** The value a target is chosen by in the dialog. */
export function shareTargetValue(target: AssetShareTarget): string {
  return target.kind === "instance" ? "instance" : target.workspaceId;
}

/** The owner an asset has once it moved to `target`. */
export function shareTargetOwner(target: AssetShareTarget): AssetOwner {
  return target.kind === "instance"
    ? { kind: "instance" }
    : { kind: "workspace", workspaceId: target.workspaceId };
}

/**
 * The rungs above where an asset sits, as the ladder goes: from Nur ich to each team the reader
 * is a member of and to Alle; from a team to Alle; from Alle nowhere. Never down or sideways.
 * `toEveryone` is false for a kind the instance cannot own, such as an App.
 */
export function shareTargets(
  owner: AssetOwner,
  workspaces: readonly BuildWorkspace[],
  { toEveryone = true }: { toEveryone?: boolean } = {}
): AssetShareTarget[] {
  if (owner.kind === "instance") return [];
  const everyone: AssetShareTarget[] = toEveryone ? [{ kind: "instance" }] : [];
  const from = workspaces.find((workspace) => workspace.id === owner.workspaceId);
  if (from?.personal !== true) return everyone;
  const teams = workspaces
    .filter((workspace) => workspace.member && workspace.personal !== true)
    .map((workspace): AssetShareTarget => ({
      kind: "workspace",
      workspaceId: workspace.id,
      name: workspace.name
    }));
  return [...teams, ...everyone];
}

/**
 * The workspaces a share is offered from: those the page names, and the reader's own that it
 * does not, such as a team where they hold no right on its assets. The page's entry wins.
 */
export function shareWorkspaces(
  known: readonly BuildWorkspace[],
  memberships: readonly BuildWorkspace[]
): readonly BuildWorkspace[] {
  const named = new Set(known.map((workspace) => workspace.id));
  const rest = memberships.filter((workspace) => !named.has(workspace.id));
  return rest.length === 0 ? known : [...known, ...rest];
}

/** What the dialog knows of the move to the chosen target. */
export type AssetShareCheckState =
  | { status: "checking" }
  /** The instance refuses the move, and says why in its own sentence. */
  | { status: "refused"; message: string }
  /** No answer came: the reader may try again. */
  | { status: "failed" }
  | { status: "ready"; check: AssetShareCheck };

/** The button's word: "Share" with the right at the target, "Send request" without it. */
export function shareSubmitLabel(
  check: Pick<AssetShareCheck, "path">
): "share.submitDirect" | "share.submitRequest" {
  return check.path === "direct" ? "share.submitDirect" : "share.submitRequest";
}

/**
 * Whether the button waits: until the check answered, and where the move breaks something
 * until the reader confirmed it. A refused move is never sent.
 */
export function shareSubmitHeld(state: AssetShareCheckState, breaksAccepted: boolean): boolean {
  if (state.status !== "ready") return true;
  return state.check.breaks.length > 0 && !breaksAccepted;
}

/** The title of a moved asset, by what an asset that stays uses. */
export function shareUsedTitle(
  check: Pick<AssetShareCheck, "moves">,
  used: { kind: string; name: string }
): string {
  return (
    check.moves.find((entry) => entry.kind === used.kind && entry.name === used.name)?.title ||
    used.name
  );
}

/**
 * The reader's own workspaces from the instance's list: the Personal one and each team they are
 * a member of. A team a superadmin only acts in is no membership.
 */
export async function readMemberships(workspaces: {
  list(input: { query: { limit: number; cursor?: string } }): Promise<{
    items: { id: string; name: string; kind: string; membershipRole: string | null }[];
    nextCursor?: string;
  }>;
}): Promise<readonly BuildWorkspace[]> {
  return (await listAll((paging) => workspaces.list({ query: paging })))
    .filter((workspace) => workspace.membershipRole !== null)
    .map((workspace): BuildWorkspace => ({
      id: workspace.id,
      name: workspace.name,
      member: true,
      ...(workspace.kind === "personal" ? { personal: true as const } : {})
    }));
}

/**
 * The source on the instance's operations: `assets.move_check` for the dialog, `assets.move` for
 * the click. `changed` hears that something moved, so the lists read it at its new place.
 */
export function createAssetShareSource(
  client: ApiClient,
  changed: (kind: string) => void
): AssetShareSource {
  const body = (subject: AssetShareSubject, to: AssetShareTarget) => ({
    ...(subject.owner.kind === "workspace" ? { workspaceId: subject.owner.workspaceId } : {}),
    to:
      to.kind === "instance"
        ? { kind: "instance" as const }
        : { kind: "workspace" as const, workspaceId: to.workspaceId },
    ...(subject.id === undefined ? {} : { expectedAssetId: subject.id })
  });
  return {
    memberships: () => readMemberships(client.workspaces),
    check: (subject, to) =>
      client.assets.move_check({
        params: { kind: subject.kind, name: subject.name },
        body: body(subject, to)
      }),
    move: async (subject, to, acceptBreaks) => {
      const outcome = await client.assets.move({
        params: { kind: subject.kind, name: subject.name },
        body: { ...body(subject, to), ...(acceptBreaks ? { acceptBreaks: true } : {}) }
      });
      if (outcome.status !== "done" || outcome.output.status !== "moved") {
        return { status: "requested" };
      }
      for (const kind of new Set(outcome.output.moves.map((entry) => entry.kind))) changed(kind);
      return { status: "moved" };
    }
  };
}
