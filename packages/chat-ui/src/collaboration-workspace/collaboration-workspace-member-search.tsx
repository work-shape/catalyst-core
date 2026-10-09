import { UserPlus } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { WorkspaceMemberCandidate } from "@vivd-catalyst/api-client";
import { Button, cn, Input, Spinner, useScrollEdgeFade } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";

/** One add-member form is on screen at a time, so fixed ids are enough here. */
const collaborationWorkspaceMemberCandidateListId = "collaboration-workspace-member-candidates";

function collaborationWorkspaceMemberCandidateOptionId(index: number): string {
  return `${collaborationWorkspaceMemberCandidateListId}-${index}`;
}

/**
 * Adds a member by email, with suggestions from the people of the instance while the field has
 * focus. The search box keeps its own listbox until the Members page is rebuilt on `Picker`.
 */
export function CollaborationWorkspaceAddMemberForm({
  memberCandidates,
  memberCandidatesLoading,
  pending,
  onMemberCandidateSearchChange,
  onAddMember
}: {
  memberCandidates: WorkspaceMemberCandidate[];
  memberCandidatesLoading: boolean;
  pending: boolean;
  /** Raw search term; the caller debounces it and owns the candidates query. */
  onMemberCandidateSearchChange(query: string): void;
  onAddMember(email: string): void;
}) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [memberCandidatesOpen, setMemberCandidatesOpen] = useState(false);
  const [highlightedMemberCandidate, setHighlightedMemberCandidate] = useState(-1);
  const comboboxRef = useRef<HTMLDivElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  // Empty results stay quiet: no dropdown, no "nothing found" copy.
  const memberCandidateListOpen = memberCandidatesOpen && memberCandidates.length > 0;
  const highlightedCandidate = memberCandidateListOpen
    ? memberCandidates[highlightedMemberCandidate]
    : undefined;

  useEffect(() => {
    setHighlightedMemberCandidate(-1);
  }, [memberCandidates]);

  useEffect(() => {
    if (!memberCandidateListOpen) {
      return;
    }

    function onPointerDown(event: PointerEvent) {
      if (!comboboxRef.current?.contains(event.target as Node)) {
        setMemberCandidatesOpen(false);
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [memberCandidateListOpen]);

  /** Selecting only fills the field; the add flow stays untouched. */
  function selectMemberCandidate(candidate: WorkspaceMemberCandidate) {
    setEmail(candidate.email);
    setMemberCandidatesOpen(false);
    setHighlightedMemberCandidate(-1);
    emailInputRef.current?.focus();
  }

  function closeMemberCandidates() {
    setMemberCandidatesOpen(false);
    setHighlightedMemberCandidate(-1);
  }

  function onEmailKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (memberCandidates.length === 0) {
        return;
      }
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      setMemberCandidatesOpen(true);
      setHighlightedMemberCandidate((current) =>
        nextCollaborationWorkspaceMemberCandidate(
          memberCandidatesOpen ? current : -1,
          offset,
          memberCandidates.length
        )
      );
      return;
    }
    if (event.key === "Enter" && highlightedCandidate) {
      event.preventDefault();
      selectMemberCandidate(highlightedCandidate);
      return;
    }
    if (event.key === "Escape" && memberCandidateListOpen) {
      // Escape closes the suggestions and nothing around them.
      event.preventDefault();
      event.stopPropagation();
      closeMemberCandidates();
      return;
    }
    if (event.key === "Tab") {
      closeMemberCandidates();
    }
  }

  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmedEmail = email.trim();
        if (!trimmedEmail || pending) {
          return;
        }
        onAddMember(trimmedEmail);
        setEmail("");
        closeMemberCandidates();
        onMemberCandidateSearchChange("");
      }}
    >
      <label className="text-sm font-medium" htmlFor="collaboration-workspace-member-email">
        {t("collaborationWorkspaceAddMemberLabel")}
      </label>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <div ref={comboboxRef} className="relative min-w-0">
          <Input
            ref={emailInputRef}
            id="collaboration-workspace-member-email"
            type="email"
            /*
             * A workspace admin adds other people here, so the browser's own
             * address autofill would only offer the operator's private
             * addresses. The neutral name keeps heuristic autofill off too.
             */
            name="collaboration-workspace-member-email"
            autoComplete="off"
            className="pr-9"
            role="combobox"
            aria-expanded={memberCandidateListOpen}
            aria-controls={collaborationWorkspaceMemberCandidateListId}
            aria-autocomplete="list"
            aria-activedescendant={
              highlightedCandidate
                ? collaborationWorkspaceMemberCandidateOptionId(highlightedMemberCandidate)
                : undefined
            }
            value={email}
            disabled={pending}
            placeholder={t("collaborationWorkspaceAddMemberPlaceholder")}
            onChange={(event) => {
              const nextEmail = event.currentTarget.value;
              setEmail(nextEmail);
              setMemberCandidatesOpen(true);
              setHighlightedMemberCandidate(-1);
              onMemberCandidateSearchChange(nextEmail.trim());
            }}
            onFocus={() => {
              setMemberCandidatesOpen(true);
              onMemberCandidateSearchChange(email.trim());
            }}
            onBlur={() => {
              // The suggestions only load while the field has focus.
              closeMemberCandidates();
              onMemberCandidateSearchChange("");
            }}
            onKeyDown={onEmailKeyDown}
          />
          {memberCandidatesLoading ? (
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
              <Spinner size="sm" />
              <span className="sr-only">{t("collaborationWorkspaceMemberCandidatesLoading")}</span>
            </span>
          ) : null}
          {memberCandidateListOpen ? (
            <CollaborationWorkspaceMemberCandidateList
              candidates={memberCandidates}
              highlightedIndex={highlightedMemberCandidate}
              onSelect={selectMemberCandidate}
            />
          ) : null}
        </div>
        <Button type="submit" variant="outline" disabled={pending}>
          <UserPlus size={16} aria-hidden="true" />
          {t("collaborationWorkspaceAddMemberSubmit")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Suggestion popover for the add-member field, styled like the workspace
 * selector menu. Options are not focusable: focus stays in the input and
 * `aria-activedescendant` carries the highlight, per the combobox pattern.
 */
export function CollaborationWorkspaceMemberCandidateList({
  candidates,
  highlightedIndex,
  onSelect
}: {
  candidates: WorkspaceMemberCandidate[];
  highlightedIndex: number;
  onSelect(candidate: WorkspaceMemberCandidate): void;
}) {
  const { t } = useTranslation();
  const fade = useScrollEdgeFade<HTMLUListElement>([candidates.length]);

  return (
    /*
      As in the emoji grid: the frame owns the rounded border and the list
      scrolls inside its padding, so the thumb stays clear of the corner radius,
      and the edge fade says whether more suggestions are hidden.
    */
    <div className="absolute left-0 right-0 top-[calc(100%+0.25rem)] z-50 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg">
      <ul
        ref={fade.ref}
        style={fade.style}
        role="listbox"
        id={collaborationWorkspaceMemberCandidateListId}
        aria-label={t("collaborationWorkspaceMemberCandidatesLabel")}
        className="chat-scrollbar grid max-h-56 auto-rows-max gap-0.5 overflow-y-auto"
        onScroll={fade.onScroll}
      >
        {candidates.map((candidate, index) => (
          <li
            key={candidate.userId}
            role="option"
            id={collaborationWorkspaceMemberCandidateOptionId(index)}
            aria-selected={index === highlightedIndex}
            data-testid="collaboration-workspace-member-candidate"
            className={cn(
              "grid min-w-0 cursor-pointer gap-0.5 rounded-md px-2 py-1.5",
              index === highlightedIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
            )}
            // Keeps the click from pulling focus out of the input.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(candidate)}
          >
            <span className="truncate text-sm font-medium">{candidate.displayLabel}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="truncate">{candidate.email}</span>
              {candidate.hasPendingAccessRequest ? (
                <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 text-[0.6875rem] text-secondary-foreground">
                  {t("collaborationWorkspaceMemberCandidatePendingRequest")}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Arrow keys wrap around, and start at either end when nothing is highlighted. */
export function nextCollaborationWorkspaceMemberCandidate(
  currentIndex: number,
  offset: number,
  count: number
): number {
  if (count === 0) {
    return -1;
  }
  const from = currentIndex < 0 ? (offset > 0 ? -1 : 0) : currentIndex;
  return (from + offset + count) % count;
}
