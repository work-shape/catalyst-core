import type { TranslationKey } from "../../../shared/i18n";
import type { GrantKind, GrantKindAction } from "../access-model";

/** What the page says of one kind: in a row of the list and at each place of the dialog. */
export interface KindWords {
  /** "Workflow {name}": one asset as the place of a row. */
  scopeAsset: TranslationKey;
  /** "the Workflow {name}": one asset as what a row's sentence allows or refuses. */
  object: TranslationKey;
  /** The choice of one asset as the place, and what it means. */
  onAsset: TranslationKey;
  onAssetDescription: TranslationKey;
  /** The field that picks the asset: its label and what it says while nothing is chosen. */
  assetField: TranslationKey;
  chooseAsset: TranslationKey;
  /** What the field says where the instance has none of the kind and where they did not load. */
  noAssets: TranslationKey;
  assetsLoadFailed: TranslationKey;
}

/** Everything the page says of one kind of grant. */
export interface GrantKindEntry<Kind extends GrantKind> {
  /** The name of the kind, in the plural. */
  label: TranslationKey;
  words: KindWords;
  /**
   * What a right allows, as the dialog says it under the action, for the rights whose verb
   * alone does not say it. A right without a sentence shows its verb.
   */
  sentences?: Partial<Record<GrantKindAction<Kind>, TranslationKey>>;
  /** Extra requirements for giving an allow, shown beside the action for an allow only. */
  allowNotes?: Partial<Record<GrantKindAction<Kind>, TranslationKey>>;
}

/** The place words of agents and skills, which kinds granted on no asset of their own reuse. */
export const configAssetWords = {
  onAsset: "access.scopeOnAsset",
  onAssetDescription: "access.scopeOnAssetDescription",
  assetField: "access.grantAsset",
  chooseAsset: "access.chooseAsset",
  noAssets: "access.noAssets",
  assetsLoadFailed: "access.referencesLoadFailed"
} as const satisfies Partial<KindWords>;
