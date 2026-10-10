import type { LucideIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import type { ConfigAssetSummary, LocaleCode } from "@vivd-catalyst/api-client";
import type { AvatarKind } from "@vivd-catalyst/ui";
import type { TranslationContextValue, TranslationKey } from "../i18n";

type Translate = TranslationContextValue["t"];

/** One asset as the Build frame lists and opens it. */
export interface BuildAsset {
  /** The asset kind, as the server stores it. */
  kind: string;
  /** The asset's id: stable, and the last segment of its address. */
  name: string;
  /** The stored configuration. Only the asset's own kind reads it. */
  config: Record<string, unknown>;
  /** The kind's default asset, where the kind has one. */
  isDefault: boolean;
  /** What the instance says about the asset beside its configuration. */
  summary: ConfigAssetSummary | undefined;
}

/** What a kind's row texts are written with. */
export interface BuildKindTexts {
  t: Translate;
  locale: LocaleCode;
}

/** How a change went. A conflict is answered by the frame and carries no message. */
export interface BuildMutationOutcome {
  ok: boolean;
  error?: string;
}

/** What the frame hands the body of an asset page. */
export interface BuildAssetEditorProps {
  /** The open asset. Absent while a new one is written. */
  asset: BuildAsset | undefined;
  /** The way back to the kind's list, for the start of the page head. */
  back: ReactNode;
  /** Hears whether the page holds changes that are not saved: the frame asks before it is left. */
  onUnsavedChange(unsaved: boolean): void;
  /** Runs a change. The frame answers a conflict with the instance; any other failure comes back as a message. */
  run(action: () => Promise<unknown>): Promise<BuildMutationOutcome>;
  /** A new asset was saved: the frame opens its page. */
  onCreated(name: string): void;
  /** The asset is gone: the frame returns to the list. */
  onDeleted(): void;
  /** The stored asset changed under the editor, as after a restore: the frame mounts it again. */
  onReloaded(): void;
}

/**
 * What the client knows about one kind of Build asset. The frame (the routes, the kind rail,
 * the list with search and pages, the page head's way back, the conflict answer and every
 * state) is the same for every kind; a slice that adds a kind adds a file of its own and one
 * entry to `buildAssetKinds`. Whether a kind is on, who may read or create it and how many
 * assets it has come from the instance, not from this entry.
 */
export interface BuildAssetKind {
  /** The asset kind, as the server stores it. */
  kind: string;
  /** The kind's segment in an address: `/build/<path>`. */
  path: string;
  /** The kind in the plural: the rail item and the list's title. */
  label: TranslationKey;
  /** Names the list's search field. */
  searchLabel: TranslationKey;
  /** The one button that starts a new asset. */
  newLabel: TranslationKey;
  /** The sentence of the empty list for a person who may create. */
  emptyText: TranslationKey;
  /** The sentence of the empty list for a person who may not. */
  emptyReadOnlyText: TranslationKey;
  /** The sentence shown at the address of an asset that does not exist. */
  missingText: TranslationKey;
  icon: LucideIcon;
  /** Rows show an avatar with the name's initials. Without it they show the kind's icon. */
  avatar?: AvatarKind;
  /** The asset's name in the reader's language. Without one the row is titled by the id. */
  title(asset: BuildAsset, locale: LocaleCode): string | undefined;
  /** The row's one status line, after the id. */
  status?(asset: BuildAsset, texts: BuildKindTexts): string | undefined;
  /** The row's badges, such as the default marker. */
  badges?(asset: BuildAsset, texts: BuildKindTexts): ReactNode;
  /** The body of the asset page, for an existing asset and for a new one. */
  Editor: ComponentType<BuildAssetEditorProps>;
}
