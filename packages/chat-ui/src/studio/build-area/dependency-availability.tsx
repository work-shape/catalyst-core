import type { Asset } from "@work-shape/catalyst-api-client";
import { Banner, Checkbox } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";

/**
 * The Knowledge Bases and Connections an agent uses that are not available in all of its
 * workspaces, and the instance admins who can make them so.
 */
export type DependencyAvailability = NonNullable<Asset["dependencyAvailability"]>;
type MissingDependency = DependencyAvailability["missing"][number];

/**
 * What the page offers for what is missing: nothing where nothing is; one choice to make all of
 * it available where the reader may make each one so; else the names of whom to ask. The
 * instance makes all of it available or none, so a reader who may not make one of them
 * available is not offered the choice.
 */
type DependencyOffer =
  | { kind: "none" }
  | { kind: "choice"; missing: readonly MissingDependency[] }
  | { kind: "ask"; missing: readonly MissingDependency[]; administrators: readonly string[] };

function dependencyOffer(dependencies: DependencyAvailability | undefined): DependencyOffer {
  const missing = dependencies?.missing ?? [];
  if (missing.length === 0) return { kind: "none" };
  if (missing.every((dependency) => dependency.canMakeAvailable)) {
    return { kind: "choice", missing };
  }
  return { kind: "ask", missing, administrators: dependencies?.administrators ?? [] };
}

/**
 * What members in some of the agent's workspaces cannot use, beside the save or the publish
 * that leaves it so. It never links to the settings of what it names: a reader who may not
 * make them available is told whom to ask.
 */
export function MissingDependencies({
  dependencies,
  makeAvailable,
  disabled = false,
  onMakeAvailableChange
}: {
  dependencies: DependencyAvailability | undefined;
  makeAvailable: boolean;
  disabled?: boolean;
  onMakeAvailableChange(on: boolean): void;
}) {
  const { locale, t } = useTranslation();
  const offer = dependencyOffer(dependencies);
  if (offer.kind === "none") return null;
  const names = new Intl.ListFormat(locale, { type: "disjunction" });
  return (
    <Banner tone="warning" title={t("configAvailabilityMissingTitle")} data-missing-dependencies="">
      <div className="grid gap-2">
        <p>{t("configAvailabilityMissingText")}</p>
        <ul className="grid gap-1" aria-label={t("configAvailabilityMissingTitle")}>
          {offer.missing.map((dependency) => (
            <li
              key={`${dependency.kind}:${dependency.name}`}
              data-missing-dependency={dependency.kind}
            >
              {t(
                dependency.kind === "knowledge_base"
                  ? "configAvailabilityMissingKnowledgeBase"
                  : "configAvailabilityMissingConnection",
                { name: dependency.displayName }
              )}
            </li>
          ))}
        </ul>
        {offer.kind === "choice" ? (
          <Checkbox
            checked={makeAvailable}
            disabled={disabled}
            label={t("configAvailabilityMakeDependencies")}
            description={t("configAvailabilityMakeDependenciesHint")}
            onCheckedChange={onMakeAvailableChange}
          />
        ) : (
          <p data-missing-dependencies-ask="">
            {offer.administrators.length > 0
              ? t("configAvailabilityAskAdmins", { names: names.format(offer.administrators) })
              : t("configAvailabilityAskAdmin")}
          </p>
        )}
      </div>
    </Banner>
  );
}
