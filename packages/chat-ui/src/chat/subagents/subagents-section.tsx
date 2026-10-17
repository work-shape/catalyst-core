import type { SubagentSummary } from "@work-shape/catalyst-api-client";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { SubagentLine } from "./subagent-card";
import { groupSubagents, isSubagentActive, subagentState } from "./subagent-model";
import { useFollowSubagent } from "./subagent-queries";

/**
 * The section Subagents of the Resources panel, first in it: the conversation's subagents in
 * two groups, Active and Done, newest first. A row opens the subagent's thread.
 */
export function SubagentsSection({
  conversationId,
  subagents
}: {
  conversationId: string;
  subagents: readonly SubagentSummary[];
}) {
  const { t } = useTranslation();
  if (subagents.length === 0) {
    return null;
  }
  const { active, done } = groupSubagents(subagents);

  return (
    <Disclosure defaultOpen data-testid="resources-subagents">
      <DisclosureTrigger className="w-full px-2 text-caption font-semibold">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate">{t("subagents.section")}</span>
          <span className="font-normal tabular-nums">{subagents.length}</span>
        </span>
      </DisclosureTrigger>
      <DisclosureContent className="pb-1">
        {[
          { key: "active", label: t("subagents.active"), items: active },
          { key: "done", label: t("subagents.done"), items: done }
        ].map((group) =>
          group.items.length === 0 ? null : (
            <section key={group.key} aria-label={group.label} className="grid gap-0.5">
              <h3 className="px-2 pt-1 text-micro font-medium text-muted-foreground uppercase">
                {group.label}
              </h3>
              {group.items.map((subagent) => (
                <SubagentRow
                  key={subagent.runId}
                  conversationId={conversationId}
                  subagent={subagent}
                />
              ))}
            </section>
          )
        )}
      </DisclosureContent>
    </Disclosure>
  );
}

function SubagentRow({
  conversationId,
  subagent
}: {
  conversationId: string;
  subagent: SubagentSummary;
}) {
  const state = subagentState(subagent.status);
  useFollowSubagent({
    rootConversationId: conversationId,
    threadId: subagent.threadId,
    runId: subagent.runId,
    active: isSubagentActive(state)
  });
  return (
    <SubagentLine
      subagent={subagent}
      description={subagent.description}
      rootConversationId={conversationId}
      state={state}
    />
  );
}
