import type { AgentAvailability, Asset } from "@work-shape/catalyst-api-client";
import { Banner, Checkbox } from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";

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
 * The sentence before the list: the workspaces it was read for by their names, where the page
 * knows each name. An agent available everywhere, or a workspace the page cannot name, keeps
 * the sentence without names: no id is ever shown.
 */
function missingText(
  availability: AgentAvailability | null | undefined,
  workspaceName: (id: string) => string | undefined,
  t: TranslationContextValue["t"],
  locale: string
): string {
  if (availability?.mode !== "selected") return t("configAvailabilityMissingText");
  const named = availability.collaborationWorkspaceIds.map(workspaceName);
  if (named.some((name) => name === undefined)) return t("configAvailabilityMissingText");
  const workspaces = [
    ...named.filter((name): name is string => name !== undefined),
    ...(availability.personalWorkspaces ? [t("configAvailabilityMissingPersonal")] : [])
  ];
  if (workspaces.length === 0) return t("configAvailabilityMissingText");
  // Each item may be missing in some of them only: "A, B or C".
  const list = new Intl.ListFormat(locale, { type: "disjunction" }).format(workspaces);
  return workspaces.length === 1
    ? t("configAvailabilityMissingInOne", { workspace: list })
    : t("configAvailabilityMissingInSome", { workspaces: list });
}

const NO_NAMES = () => undefined;

/**
 * What members in some of the agent's workspaces cannot use, beside the create, the save or the
 * publish that leaves it so, with the workspaces named where the page knows their names. It
 * never links to the settings of what it names: a reader who may not make them available is
 * told whom to ask.
 */
export function MissingDependencies({
  dependencies,
  availability = dependencies?.availability,
  workspaceName = NO_NAMES,
  makeAvailable,
  disabled = false,
  onMakeAvailableChange
}: {
  dependencies: DependencyAvailability | undefined;
  /** Where the agent would be available, as the list was read for. Defaults to what it says. */
  availability?: AgentAvailability | null;
  /** The name of a shared workspace by its id, as the page loaded it. */
  workspaceName?: (id: string) => string | undefined;
  makeAvailable: boolean;
  disabled?: boolean;
  onMakeAvailableChange(on: boolean): void;
}) {
  const { locale, t } = useTranslation();
  const offer = dependencyOffer(dependencies);
  if (offer.kind === "none") return null;
  // The instance names the workspaces it read the list for; the page's own names stand in for
  // an instance that does not.
  const nameOf = (id: string) =>
    dependencies?.workspaces?.find((workspace) => workspace.id === id)?.name ?? workspaceName(id);
  const names = new Intl.ListFormat(locale, { type: "disjunction" });
  return (
    <Banner tone="warning" title={t("configAvailabilityMissingTitle")} data-missing-dependencies="">
      <div className="grid gap-2">
        <p data-missing-dependencies-text="">{missingText(availability, nameOf, t, locale)}</p>
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
