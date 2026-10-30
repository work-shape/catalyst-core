// @rights-screen: included in the rights wording guard.
import type {
  MemberBundle,
  WorkspaceBundle,
  WorkspaceMemberBundles
} from "@work-shape/catalyst-api-client";
import { WORKSPACE_BUNDLES, type MemberBundleChange } from "@work-shape/catalyst-core";
import { Switch } from "@work-shape/catalyst-ui";
import { useId } from "react";
import { useTranslation, type TranslationKey } from "../../../shared/i18n";

// AP-3: a member's Builder and Publisher as two switches under the member's row. On means held
// or asked for. What a switch does is the server's answer for the caller: an Owner or Admin
// asks for it and takes it back, an instance admin who holds it gives it at once, and who asked
// withdraws the request. A switch the caller may not change is shown and cannot be turned.

const bundleLabels: Record<WorkspaceBundle, TranslationKey> = {
  builder: "rights.actionBuilder",
  publisher: "rights.actionPublisher"
};

/** What a switch says beside its name, where on alone does not say it. */
const stateNotes: Partial<Record<MemberBundle["state"], TranslationKey>> = {
  requested: "workspaceBundles.requested",
  inherited: "workspaceBundles.inherited"
};

export interface MemberBundleTurn {
  bundle: WorkspaceBundle;
  change: MemberBundleChange;
  requestId?: string;
}

export function MemberBundleSwitches({
  name,
  bundles,
  pending,
  onTurn
}: {
  /** The member, for the switches' accessible names. */
  name: string;
  bundles: WorkspaceMemberBundles;
  /** A change of a bundle is under way: no switch turns meanwhile. */
  pending: boolean;
  onTurn(turn: MemberBundleTurn): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2" data-member-bundles="">
      {WORKSPACE_BUNDLES.map((bundle) => (
        <BundleSwitch
          key={bundle}
          name={name}
          bundle={bundle}
          value={bundles[bundle]}
          pending={pending}
          onTurn={onTurn}
        />
      ))}
    </div>
  );
}

function BundleSwitch({
  name,
  bundle,
  value,
  pending,
  onTurn
}: {
  name: string;
  bundle: WorkspaceBundle;
  value: MemberBundle;
  pending: boolean;
  onTurn(turn: MemberBundleTurn): void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const noteId = useId();
  const label = t(bundleLabels[bundle]);
  const note = stateNotes[value.state];
  const { change } = value;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-2"
      data-bundle={bundle}
      data-bundle-state={value.state}
    >
      <Switch
        id={id}
        checked={value.state !== "none"}
        disabled={pending || change === undefined}
        aria-label={t("workspaceBundles.switch", { bundle: label, name })}
        {...(note ? { "aria-describedby": noteId } : {})}
        onCheckedChange={() => {
          if (change)
            onTurn({
              bundle,
              change,
              ...(value.requestId === undefined ? {} : { requestId: value.requestId })
            });
        }}
      />
      <label htmlFor={id} className="text-caption">
        {label}
      </label>
      {note ? (
        <span id={noteId} className="text-caption text-muted-foreground">
          {t(note)}
        </span>
      ) : null}
    </span>
  );
}
