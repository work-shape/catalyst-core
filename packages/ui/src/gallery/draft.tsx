import { useState } from "react";
import { Button } from "../actions/button";
import { RunLiveOnce } from "../actions/run-live-once";
import { ChangeList } from "../data/change-list";
import { TextDiff } from "../data/text-diff";
import { DraftHeader } from "../feedback/draft-header";
import { Field } from "../forms/field";
import { Textarea } from "../forms/input";
import { TextVersionSwitch, VersionedText, type TextVersion } from "../forms/versioned-text";
import { StatusPill } from "../status/status-pill";
import { ChangeTag, type ChangeKind } from "../status/change-tag";
import { TargetBadge } from "../status/target-badge";
import { Samples, type GalleryEntry } from "./entry";
import type { GalleryText } from "./text";

const changeKinds: readonly ChangeKind[] = ["new", "changed", "removed", "unsaved"];

/** The head of a draft: simulated, with a test copy and its way, and never published. */
export const draftHeaderEntry: GalleryEntry = {
  name: "DraftHeader",
  components: ["DraftHeader"],
  render: (text) => (
    <div className="grid gap-4">
      <DraftHeader
        className="border"
        live={{ version: 3, by: text.draftPerson, at: text.draftDate }}
        changes={text.draftChanges}
        action={
          <>
            <Button variant="outline" size="sm">
              {text.draftTest}
            </Button>
            <Button variant="outline" size="sm">
              {text.publish}
            </Button>
          </>
        }
      />
      <DraftHeader
        className="border"
        targets={[
          { name: text.draftStore, kind: "copy", link: <a href="#test-copy" /> },
          { name: text.draftConnection, kind: "credential" }
        ]}
        live={{ version: 7 }}
      />
      <Samples label={text.draftNever}>
        <DraftHeader className="w-full border" live={null} />
      </Samples>
    </div>
  )
};

/** The changing actions a publish makes live, an added host, and a changed step's detail. */
export const changeListEntry: GalleryEntry = {
  name: "ChangeList",
  components: ["ChangeList"],
  render: (text) => (
    <div className="grid max-w-md gap-4">
      <ChangeList
        aria-label={text.changeListLabel}
        mono
        items={[
          {
            id: "send",
            label: text.changeActionSend,
            change: "new",
            detail: text.changeCalls
          },
          { id: "book", label: text.changeActionBook, change: "changed" },
          { id: "host", label: text.changeHost, change: "new" }
        ]}
      />
    </div>
  )
};

/** A file as it is live against the draft, with the kept lines between two changes folded. */
export const textDiffEntry: GalleryEntry = {
  name: "TextDiff",
  components: ["TextDiff"],
  render: (text) => (
    <div className="grid gap-4 sm:grid-cols-2">
      <Samples label="changed">
        <TextDiff
          className="w-full rounded-md border"
          before={text.diffBefore}
          after={text.diffAfter}
          context={2}
        />
      </Samples>
      <Samples label="new">
        <TextDiff className="w-full rounded-md border" after={text.changeHost} />
      </Samples>
      <Samples label="same">
        <TextDiff
          className="w-full rounded-md border"
          before={text.diffAfter}
          after={text.diffAfter}
        />
      </Samples>
    </div>
  )
};

/** The four words of a change, and the marker of where a draft's call went beside them. */
export const changeTagEntry: GalleryEntry = {
  name: "ChangeTag",
  components: ["ChangeTag"],
  render: (text) => (
    <div className="grid gap-3">
      <Samples>
        {changeKinds.map((change) => (
          <ChangeTag key={change} change={change} />
        ))}
      </Samples>
      <Samples label="step">
        <span className="font-medium">{text.changeActionSend}</span>
        <ChangeTag change="changed" />
        <TargetBadge target="dry_run" />
        <RunLiveOnce state="off" onText={text.liveOnceOn} onSwitchOn={() => undefined} />
      </Samples>
    </div>
  )
};

/** The one state beside a name: a draft that is not live, with what it is one press away, or Live. */
export const statusPillEntry: GalleryEntry = {
  name: "StatusPill",
  components: ["StatusPill"],
  render: (text) => (
    <Samples>
      <StatusPill
        tone="draft"
        label={text.pillDraft}
        details={
          <>
            <p>{text.pillDetails}</p>
            <div>
              <Button variant="outline" size="sm">
                {text.pillChanges}
              </Button>
            </div>
          </>
        }
      />
      <StatusPill tone="draft" label={text.pillDraft} />
      <StatusPill tone="live" label={text.pillLive} />
    </Samples>
  )
};

function VersionedTextSample({ text }: { text: GalleryText }) {
  const [view, setView] = useState<TextVersion>("changes");
  const [draft, setDraft] = useState(text.versionedDraft);
  return (
    <Field
      className="max-w-lg"
      label={text.versionedLabel}
      hint={text.versionedLine}
      labelEnd={
        <TextVersionSwitch label={text.versionedLabel} value={view} onValueChange={setView} />
      }
    >
      <VersionedText
        label={text.versionedLabel}
        view={view}
        live={text.versionedLive}
        draft={draft}
        mono
      >
        <Textarea
          variant="code"
          className="min-h-32"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </VersionedText>
    </Field>
  );
}

/** A field with a live version: the draft, the live text or the changed lines, in one box. */
export const versionedTextEntry: GalleryEntry = {
  name: "VersionedText",
  components: ["VersionedText", "TextVersionSwitch"],
  render: (text) => <VersionedTextSample text={text} />
};
