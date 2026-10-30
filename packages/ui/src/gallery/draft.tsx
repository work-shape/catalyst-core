import { Button } from "../actions/button";
import { RunLiveOnce } from "../actions/run-live-once";
import { ChangeList } from "../data/change-list";
import { TextDiff } from "../data/text-diff";
import { DraftHeader } from "../feedback/draft-header";
import { ChangeTag, type ChangeKind } from "../status/change-tag";
import { TargetBadge } from "../status/target-badge";
import { Samples, type GalleryEntry } from "./entry";

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
