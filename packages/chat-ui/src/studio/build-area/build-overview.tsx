import { MessageSquare, Plus } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  List,
  ListRow,
  PageHeader,
  RegistryIcon
} from "@work-shape/catalyst-ui";
import { AGENT_ASSET_KIND } from "../../shared/build-rights";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { BuildWithAgentDialog } from "../build-with-agent-dialog";
import { isEditableKind, type BuildKind } from "./build-asset-kind";
import type { BuildSource } from "./build-data";
import { BUILT_WITH_AGENT } from "./build-list-empty";
import type { VisibleBuildKind } from "./build-model";

/** The id of the overview's item in Studio's rail. No kind has this path. */
export const BUILD_OVERVIEW_ID = "overview";

/** The mark of a kind before a row: its icon on a quiet tile. */
export function KindMark({ entry }: { entry: BuildKind }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-8 place-items-center rounded-md bg-muted text-muted-foreground"
    >
      <RegistryIcon name={entry.icon} className="size-4" />
    </span>
  );
}

/**
 * What the reader may start of a kind, in the words of the kind's own New button: an asset
 * with a page, or one the agent builds where the instance offers that agent. Nothing where the
 * reader may not create one, exactly as on the kind's list.
 */
function newLabelOf(
  { entry, state }: VisibleBuildKind,
  source: BuildSource
): TranslationKey | undefined {
  if (!state.canCreate) return undefined;
  if (isEditableKind(entry)) return entry.newLabel;
  return source.buildWithAgent ? BUILT_WITH_AGENT[entry.kind]?.label : undefined;
}

/** How many assets a kind's list holds: the rows of its first read, and whether more follow. */
interface KindCount {
  /** Absent until the list answered, and where it could not be read. */
  rows: number | undefined;
  more: boolean;
}

/**
 * Reads each kind's list as its own page does, one component per kind, and hands the counts on
 * in the order of the kinds. The reads are the lists' own, so a list opened from here is there
 * at once.
 */
function KindCounts({
  source,
  kinds,
  counted = [],
  children
}: {
  source: BuildSource;
  kinds: readonly VisibleBuildKind[];
  counted?: readonly KindCount[];
  children(counts: readonly KindCount[]): ReactNode;
}) {
  const [next, ...rest] = kinds;
  if (!next) return children(counted);
  return (
    <KindCountRead key={next.entry.kind} source={source} kind={next}>
      {(count) => (
        <KindCounts source={source} kinds={rest} counted={[...counted, count]}>
          {children}
        </KindCounts>
      )}
    </KindCountRead>
  );
}

function KindCountRead({
  source,
  kind,
  children
}: {
  source: BuildSource;
  kind: VisibleBuildKind;
  children(count: KindCount): ReactNode;
}) {
  const list = source.useList(kind.entry.kind, { text: "" });
  return children({ rows: list.error ? undefined : list.rows?.length, more: list.hasMore });
}

/**
 * Where Studio opens: one row per kind the reader sees, each with a sentence on what the kind
 * is for, how many there are once there is one, and the way to its list. "New" offers what the
 * reader may start, by each kind's own way of starting one. While nothing is built, the first
 * kind the reader may start says so in its row.
 */
export function BuildOverview({
  source,
  kinds,
  loadError,
  hrefOf,
  onOpen,
  onNew
}: {
  source: BuildSource;
  kinds: readonly VisibleBuildKind[];
  loadError: ReactNode;
  /** The address of a kind's list: a row is a link to it. */
  hrefOf(kindPath: string): string;
  onOpen(kindPath: string): void;
  /** Starts a new asset of a kind, as the New button of its list does. */
  onNew(kindPath: string): void;
}) {
  const { t } = useTranslation();
  const [briefing, setBriefing] = useState(false);
  const creatable = kinds.flatMap((kind) => {
    const label = newLabelOf(kind, source);
    return label ? [{ kind, label }] : [];
  });
  const buildWithAgent = creatable.length > 0 ? source.buildWithAgent : undefined;
  const newMenu =
    creatable.length > 0 ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button data-build-overview-new="">
            <Plus aria-hidden="true" />
            {t("build.overviewNew")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {creatable.map(({ kind, label }) => (
            <DropdownMenuItem
              key={kind.entry.kind}
              icon={<RegistryIcon name={kind.entry.icon} />}
              onSelect={() => onNew(kind.entry.path)}
            >
              {t(label)}
            </DropdownMenuItem>
          ))}
          {buildWithAgent ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                icon={<MessageSquare aria-hidden="true" />}
                onSelect={() => setBriefing(true)}
              >
                {t("build.briefBuild")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : undefined;

  return (
    <KindCounts source={source} kinds={kinds}>
      {(counts) => {
        // Nothing is built once every list answered with none. Until then the page says nothing
        // about a first step, so it never offers one over what is there.
        const nothingBuilt = counts.every((count) => count.rows === 0);
        const first = nothingBuilt ? creatable[0] : undefined;
        return (
          <>
            <PageHeader
              title={t("build.overview")}
              description={t(
                first?.kind.entry.kind === AGENT_ASSET_KIND
                  ? "build.overviewEmptyLead"
                  : "build.overviewLead"
              )}
              primaryAction={newMenu}
            />
            {loadError}
            <List aria-label={t("build.overviewList")} data-build-overview="">
              {kinds.map((kind, index) => {
                const { entry } = kind;
                const count = counts[index];
                const starts = first?.kind === kind ? first : undefined;
                return (
                  <ListRow
                    key={entry.kind}
                    data-build-overview-kind={entry.path}
                    leading={<KindMark entry={entry} />}
                    title={t(entry.label)}
                    descriptionWraps
                    description={t(entry.overviewText)}
                    time={
                      count?.rows ? (
                        <span className="tabular-nums" data-build-overview-count="">
                          {count.more ? t("build.overviewMore", { count: count.rows }) : count.rows}
                        </span>
                      ) : undefined
                    }
                    {...(starts
                      ? {
                          actions: (
                            <Button
                              variant="outline"
                              size="sm"
                              data-build-overview-first=""
                              onClick={() => onNew(entry.path)}
                            >
                              {t(starts.label)}
                            </Button>
                          ),
                          actionsVisible: true
                        }
                      : {})}
                    link={
                      <a
                        href={hrefOf(entry.path)}
                        onClick={(event) => {
                          if (opensHere(event)) {
                            event.preventDefault();
                            onOpen(entry.path);
                          }
                        }}
                      />
                    }
                  />
                );
              })}
            </List>
            {briefing && buildWithAgent ? (
              <BuildWithAgentDialog
                title={t("build.briefBuild")}
                prompt=""
                onBuild={buildWithAgent}
                onClose={() => setBriefing(false)}
              />
            ) : null}
          </>
        );
      }}
    </KindCounts>
  );
}

/** A plain click opens the page here. With a modifier or another button the browser decides. */
function opensHere(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
