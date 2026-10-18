import type {
  ActorAccess,
  LocaleCode,
  ConfigAssetKind,
  ConfigAssetRecord,
  ConfigAssetState
} from "@work-shape/catalyst-core";
import { readDefinitionName, type WorkflowAssetKind } from "../asset-kinds/shared";
import type { AssetWorkflowOptions } from "../types";
import { assetKindLabel } from "./asset-reference-labels";
import { listedTo } from "./asset-access";
import {
  assetSetOf,
  definitionsOf,
  findAssetSetIssues,
  findDefinition,
  type AssetSet,
  type AssetSetIssue
} from "./asset-set";

export interface StoredAssets {
  state: ConfigAssetState;
  assets: ConfigAssetRecord[];
  set: AssetSet;
}

/** What a refused change is told of an asset its caller may not read: that there is one. */
const unreadAssetIssue = (locale: LocaleCode) =>
  locale === "de"
    ? "Die Änderung würde ein Asset beschädigen, das der Aufrufer nicht lesen darf"
    : "The change would break an asset the caller may not read";

/** The stored assets as one caller's change is checked against them. */
interface ReferableAssets {
  /**
   * What a definition of the caller is resolved against: the assets the chooser offers and
   * the instance's default.
   */
  set: AssetSet;
  /** The assets the chooser offers, and no other. */
  readable: AssetSet;
  /** Nothing was left out of `set`: it is the stored set itself. */
  complete: boolean;
}

/**
 * What a caller's definition is resolved against: exactly the assets the choosers offer.
 * Every other asset is left out, one beside the written asset in its Namespace included, so a
 * reference to it reads as a reference to nothing. The instance's default stays in, because
 * the rule that an instance with agents has one is about the set and not about the change.
 */
export function loadReferableAssets(
  options: AssetWorkflowOptions,
  access: ActorAccess,
  stored: StoredAssets
): ReferableAssets {
  const isReadable = (asset: ConfigAssetRecord) => {
    const kind = options.configAssets.kinds.get(asset.kind);
    return (
      kind === undefined ||
      listedTo(kind, access, { ...asset, published: asset.publishedRevisionId !== undefined })
    );
  };
  const unread = new Set(stored.assets.filter((asset) => !isReadable(asset)));
  if (unread.size === 0) {
    return { set: stored.set, readable: stored.set, complete: true };
  }
  const isInstanceDefault = (asset: ConfigAssetRecord) =>
    asset.name === stored.state.defaultAgentName &&
    options.configAssets.kinds.get(asset.kind)?.holdsInstanceDefault === true;
  const { defaultAgentName } = stored.state;
  return {
    set: assetSetOf(
      stored.assets.filter((asset) => !unread.has(asset) || isInstanceDefault(asset)),
      defaultAgentName
    ),
    readable: assetSetOf(
      stored.assets.filter((asset) => !unread.has(asset)),
      defaultAgentName
    ),
    complete: false
  };
}

/**
 * What a change is refused for, as its caller may be told. `change` makes of a set what the
 * change would leave of it.
 *
 * The change is read against the view, which leaves assets out. The view has issues of its
 * own, because what it keeps may refer to what it leaves out: those are not the change's and
 * are not told. A reference already stored may be kept when only the caller cannot read
 * its target; an actually unavailable reference is still checked strictly on a changed agent.
 * An issue that arises only because of
 * an asset the caller may not read, in the view or in the stored set as a whole, is told as
 * one sentence that names nothing.
 */
export function findIssuesOfChange(
  kinds: readonly WorkflowAssetKind[],
  stored: AssetSet,
  view: ReferableAssets,
  change: (set: AssetSet) => AssetSet,
  /** The keys of the definitions the change writes. */
  changed: ReadonlySet<string>,
  locale: LocaleCode = "en"
): AssetSetIssue[] {
  const key = (issue: AssetSetIssue) => JSON.stringify([issue.message, issue.path?.map(String)]);
  const keysOf = (issues: readonly AssetSetIssue[]) => new Set(issues.map(key));
  // Only the caller's missing read access may excuse an existing reference. A target that
  // is missing from the instance itself must still refuse a changed definition.
  const storedIssues = keysOf(findAssetSetIssues(kinds, stored).issues);
  const before = new Map<string, number>();
  for (const issue of findAssetSetIssues(kinds, view.set).issues) {
    if (!storedIssues.has(key(issue))) {
      before.set(key(issue), (before.get(key(issue)) ?? 0) + 1);
    }
  }
  const ofChange = findAssetSetIssues(kinds, change(view.set), view.set).issues.filter((issue) => {
    if (issue.assetKind !== undefined && issue.assetName !== undefined) {
      // An issue of one definition is the change's when the change writes that definition.
      return changed.has(assetKey(issue.assetKind, issue.assetName));
    }
    const count = before.get(key(issue)) ?? 0;
    before.set(key(issue), count - 1);
    return count <= 0;
  });
  // A kind may allow an unfinished draft to name a target that does not exist yet. Keep
  // that policy, but never let the same draft select an existing asset its chooser hides.
  if (ofChange.length === 0) {
    const selected = change(view.readable);
    for (const kind of kinds) {
      for (const definition of definitionsOf(selected, kind.kind)) {
        const name = readDefinitionName(definition);
        if (name === undefined || !changed.has(assetKey(kind.kind, name))) continue;
        const before = findDefinition(stored, kind.kind, name);
        const retained = new Set(
          (before === undefined ? [] : (kind.references?.(before) ?? [])).map((ref) =>
            assetKey(ref.kind, ref.name)
          )
        );
        const reported = new Set<string>();
        for (const ref of kind.references?.(definition) ?? []) {
          const referenceKey = assetKey(ref.kind, ref.name);
          if (reported.has(referenceKey)) continue;
          if (
            retained.has(assetKey(ref.kind, ref.name)) ||
            findDefinition(stored, ref.kind, ref.name) === undefined ||
            findDefinition(selected, ref.kind, ref.name) !== undefined
          )
            continue;
          reported.add(referenceKey);
          ofChange.push({
            message:
              locale === "de"
                ? `${assetKindLabel(kind.kind, locale)} '${name}' verweist auf unbekanntes Asset: ${assetKindLabel(ref.kind, locale)} '${ref.name}'`
                : `${assetKindLabel(kind.kind, locale)} '${name}' references unknown ${assetKindLabel(ref.kind, locale)} '${ref.name}'`,
            assetKind: kind.kind,
            assetName: name
          });
        }
      }
    }
    if (ofChange.length > 0) return ofChange;
  }
  // What the change is refused for with nothing but readable assets around it is the
  // caller's to hear. Every other issue is there because of an asset the caller may not read.
  const amongReadable = keysOf(
    findAssetSetIssues(kinds, change(view.readable), view.readable).issues
  );
  const told = ofChange.filter((issue) => amongReadable.has(key(issue)));
  const toldKeys = keysOf(told);
  const untold =
    told.length < ofChange.length ||
    findAssetSetIssues(kinds, change(stored), stored).issues.some(
      (issue) => !toldKeys.has(key(issue))
    );
  return untold ? [...told, { message: unreadAssetIssue(locale) }] : told;
}

export function assetKey(kind: ConfigAssetKind, name: string): string {
  return `${kind}:${name}`;
}
