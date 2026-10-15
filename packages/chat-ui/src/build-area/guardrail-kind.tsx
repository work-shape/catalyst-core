import { Badge } from "@vivd-catalyst/ui";
import type { BuildAssetViewProps, BuildListedKind } from "./build-asset-kind";
import { GUARDRAIL_OUTCOME_VIEWS, guardrailFactsOfRow, readOutcome } from "./guardrail-model";
import { GuardrailPage } from "./guardrail-page";
import { GuardrailRunLine } from "./guardrail-run-line";
import { useGuardrailSource, useShippedGuardrails } from "./guardrail-source";
import { ShippedGuardrails } from "./shipped-guardrails";
import {
  useOptionalSettingsPage,
  type SettingsPageContextValue
} from "../settings/settings-page-context";

/** The kind's segment in an address: `/build/guardrails`. */
const GUARDRAILS_BUILD_PATH = "guardrails";

/** The Guardrail page on the instance's own answers. */
function GuardrailAssetPage(frame: BuildAssetViewProps) {
  return <GuardrailPage {...frame} source={useGuardrailSource()} />;
}

/**
 * The guardrails the release ships, with their switches, above the list. Outside the settings
 * pages, as in a list rendered alone, there is no instance to ask, and it shows nothing.
 */
function ShippedGuardrailsHead() {
  const settings = useOptionalSettingsPage();
  return settings ? <ShippedGuardrailsOf settings={settings} /> : null;
}

function ShippedGuardrailsOf({ settings }: { settings: SettingsPageContextValue }) {
  return <ShippedGuardrails read={useShippedGuardrails(settings)} />;
}

/**
 * Guardrails in Studio: the guardrails the release ships with their switches, a list, and a
 * page that shows one Guardrail with its hits. The kind has no editor and no button that
 * starts one until EW-6b. A row says in one line when the guardrail runs and what it does, and
 * its badge what a hit does.
 */
export const guardrailKind: BuildListedKind = {
  kind: "guardrail",
  path: GUARDRAILS_BUILD_PATH,
  label: "guardrails.kind",
  description: "guardrails.description",
  searchLabel: "guardrails.search",
  emptyText: "guardrails.empty",
  icon: "guardrail",
  ListHead: ShippedGuardrailsHead,
  view: { Page: GuardrailAssetPage, missingText: "guardrails.missing" },
  // When it runs and what it does, in one line: the description is on its page.
  RowLine: ({ asset }) => (
    <GuardrailRunLine facts={guardrailFactsOfRow(asset.attributes, asset.scope)} />
  ),
  // Only what a hit does: the page says when and how it checks.
  badges: (asset, t) => {
    const outcome = asset.attributes?.outcome;
    if (outcome === undefined) return null;
    const view = GUARDRAIL_OUTCOME_VIEWS[readOutcome(outcome)];
    return (
      <Badge tone={view.tone} dot>
        {t(view.label)}
      </Badge>
    );
  }
};
