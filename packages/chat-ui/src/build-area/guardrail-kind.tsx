import { ShieldCheck } from "lucide-react";
import { Badge } from "@vivd-catalyst/ui";
import type { BuildAssetViewProps, BuildListedKind } from "./build-asset-kind";
import { GUARDRAIL_OUTCOME_VIEWS } from "./guardrail-model";
import { GuardrailPage } from "./guardrail-page";
import { useGuardrailSource } from "./guardrail-source";

/** The kind's segment in an address: `/build/guardrails`. */
const GUARDRAILS_BUILD_PATH = "guardrails";

/** The Guardrail page on the instance's own answers. */
function GuardrailAssetPage(frame: BuildAssetViewProps) {
  return <GuardrailPage {...frame} source={useGuardrailSource()} />;
}

/**
 * Guardrails in Build: a list, and a page that shows one Guardrail with its hits. Release
 * config defines them so far, so the kind has no editor and no button that starts one. A row
 * says what a hit does; the page says what is checked and when.
 */
export const guardrailKind: BuildListedKind = {
  kind: "guardrail",
  path: GUARDRAILS_BUILD_PATH,
  label: "guardrails.kind",
  description: "guardrails.description",
  searchLabel: "guardrails.search",
  emptyText: "guardrails.empty",
  icon: ShieldCheck,
  view: { Page: GuardrailAssetPage, missingText: "guardrails.missing" },
  rowText: (asset) => asset.description,
  // Only what a hit does: every Guardrail is checked by a model so far, and its page says so.
  badges: (asset, t) => {
    const outcome = asset.attributes?.outcome;
    const view =
      outcome === "block" || outcome === "warn" ? GUARDRAIL_OUTCOME_VIEWS[outcome] : undefined;
    return view ? (
      <Badge tone={view.tone} dot>
        {t(view.label)}
      </Badge>
    ) : null;
  }
};
