import { Database } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { DATA_STORE_USE_TOOL_NAME } from "@work-shape/catalyst-core";
import { Button, Card, FormNotice, IconTile } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { toolAnswer } from "../conversation/subject-run";

// A Data Store added to the conversation for reading (STORE-USE-1), as a card. The person's own
// store was added at once: the card says so. Any other store waits for the person's click: the
// card asks. A conversation others read gets no store: the tool refuses there.
// The click adds the store with the person's own rights and then tells the conversation, as the
// person, so the agent goes on in the same turn of work.

export { DATA_STORE_USE_TOOL_NAME };

/** The answer of `data_store.use` as the card reads it. */
export interface DataStoreUse {
  name: string;
  title: string;
  added: boolean;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** The store the tool answered, or nothing for an answer that is none, such as a refusal. */
export function readDataStoreUse(result: unknown): DataStoreUse | undefined {
  const answer = toolAnswer(result);
  const name = textOf(answer?.name);
  if (name === undefined || typeof answer?.added !== "boolean") return undefined;
  return {
    name,
    title: textOf(answer.title) ?? name,
    added: answer.added && answer.awaitsPerson !== true
  };
}

/** A call whose card is a Data Store added to the conversation, or waiting for the person. */
export function isDataStoreUseCall(part: {
  type: string;
  toolName?: string;
  result?: unknown;
}): boolean {
  return (
    part.type === "tool-call" &&
    part.toolName === DATA_STORE_USE_TOOL_NAME &&
    readDataStoreUse(part.result) !== undefined
  );
}

/** What the card is handed by the workspace: the add and how its word reaches the agent. */
export interface DataStoreUseHost {
  /** Adds the store to the conversation on screen, as the person's confirmation of the call. */
  add(store: string, toolCallId: string): Promise<void>;
  /** Sends the person's message to the conversation, queued behind a run that goes. */
  tell(text: string): Promise<void>;
}

const DataStoreUseHostContext = createContext<DataStoreUseHost | undefined>(undefined);

export function DataStoreUseHostProvider({
  value,
  children
}: {
  value: DataStoreUseHost | undefined;
  children: ReactNode;
}) {
  return (
    <DataStoreUseHostContext.Provider value={value}>{children}</DataStoreUseHostContext.Provider>
  );
}

/** Where the card stands: asking, adding after the click, added, or the add failed. */
export type DataStoreUseCardState = "open" | "adding" | "added" | "failed";

/** The card of one `data_store.use` call in the thread. */
export function DataStoreUseCard({ toolCallId, use }: { toolCallId: string; use: DataStoreUse }) {
  const host = useContext(DataStoreUseHostContext);
  const { t } = useTranslation();
  const [state, setState] = useState<DataStoreUseCardState>(use.added ? "added" : "open");
  const confirm = host
    ? () => {
        setState("adding");
        host
          .add(use.name, toolCallId)
          .then(() => {
            setState("added");
            return host.tell(t("dataStores.useTell", { title: use.title }));
          })
          .catch(() => setState((now) => (now === "added" ? now : "failed")));
      }
    : undefined;
  return (
    <div className="chat-tool-part my-3 max-w-3xl" data-testid="tool-call-card">
      <DataStoreUseCardView use={use} state={state} {...(confirm ? { onConfirm: confirm } : {})} />
    </div>
  );
}

/** The card as it shows the store: asking, or added. */
export function DataStoreUseCardView({
  use,
  state,
  onConfirm
}: {
  use: DataStoreUse;
  state: DataStoreUseCardState;
  /** Adds the store; absent where the card cannot. */
  onConfirm?: () => void;
}) {
  const { t } = useTranslation();
  const added = state === "added";
  return (
    <Card
      padding="md"
      className="min-w-0 overflow-hidden"
      role="group"
      aria-label={
        added
          ? t("dataStores.useAdded", { title: use.title })
          : t("dataStores.useTitle", { title: use.title })
      }
      data-testid="data-store-use-card"
      data-state={added ? "added" : "open"}
      data-store={use.name}
    >
      <div className="flex min-w-0 items-start gap-3 p-4">
        <IconTile>
          <Database aria-hidden="true" />
        </IconTile>
        <div className="grid min-w-0 flex-1 gap-1 self-center">
          <p className="text-label text-foreground wrap-anywhere">
            {added
              ? t("dataStores.useAdded", { title: use.title })
              : t("dataStores.useTitle", { title: use.title })}
          </p>
          {added ? null : (
            <p className="text-caption text-muted-foreground">{t("dataStores.useBody")}</p>
          )}
        </div>
        {added || onConfirm === undefined ? null : (
          <Button size="sm" disabled={state === "adding"} onClick={onConfirm}>
            {t("dataStores.useAllow")}
          </Button>
        )}
      </div>
      {state === "failed" ? (
        <div className="px-4 pb-4">
          <FormNotice tone="error">{t("dataStores.useFailed")}</FormNotice>
        </div>
      ) : null}
    </Card>
  );
}
