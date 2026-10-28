import { Database, X } from "lucide-react";
import { IconButton, Picker, PickerButton, Select } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import {
  heldDataStores,
  withChosenDataStores,
  withDataStoreAccess,
  type DataStoreAccess
} from "./agent-data-stores-model";
import type { MoreRead } from "./paged-items";

/** One Data Store as the chooser shows it. */
interface DataStoreOption {
  name: string;
  title: string;
  description?: string;
}

/** The Data Stores an agent can be given, as far as the instance was asked for them. */
export interface DataStoreChoice {
  /** The stores of the agent's own place and of everyone that match the search, read so far. */
  options: readonly DataStoreOption[];
  /** Present while more match: the chooser's last row reads the next page. */
  more?: MoreRead;
  /** The reader typed into the search: the instance is asked for the stores that match. */
  onSearch(text: string): void;
  /**
   * Stores the reader sees that this agent cannot use, such as their own for an agent of
   * everyone or a team's for an agent of another place: greyed with the reason, not hidden.
   */
  unusable?: readonly (DataStoreOption & { reason: string })[];
}

/**
 * The Data Stores an agent works with: one row per store with what it may do there, and the
 * chooser. What it holds is its tool list, which this reads and writes: `toolNames` in, the
 * whole new list out.
 */
export function AgentDataStores({
  choice,
  toolNames,
  editable,
  onChange
}: {
  choice: DataStoreChoice;
  toolNames: readonly string[];
  editable: boolean;
  onChange(toolNames: string[]): void;
}) {
  const { t } = useTranslation();
  const held = heldDataStores(toolNames);
  const byName = new Map(
    [...(choice.unusable ?? []), ...choice.options].map((option) => [option.name, option])
  );
  const accessLabel = (access: DataStoreAccess) =>
    t(access === "change" ? "dataStores.agentChange" : "dataStores.agentRead");
  return (
    <>
      {held.length === 0 ? (
        <p className="text-body text-muted-foreground">{t("dataStores.agentNone")}</p>
      ) : (
        // At phone width the choice of access goes below the store's title rather than cut it.
        <ul
          aria-label={t("dataStores.agentSection")}
          data-agent-data-stores=""
          className="grid min-w-0 gap-2"
        >
          {held.map(({ store, access }) => {
            const title = byName.get(store)?.title || store;
            return (
              <li
                key={store}
                data-agent-data-store={store}
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
              >
                <span className="flex min-w-0 flex-1 basis-40 items-center gap-2 text-body">
                  <Database aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 wrap-anywhere">{title}</span>
                </span>
                {editable ? (
                  <span className="flex items-center gap-1">
                    <Select
                      size="sm"
                      className="w-48"
                      aria-label={t("dataStores.agentAccess", { name: title })}
                      value={access}
                      onChange={(event) =>
                        onChange(
                          withDataStoreAccess(
                            toolNames,
                            store,
                            event.target.value === "change" ? "change" : "read"
                          )
                        )
                      }
                    >
                      <option value="read">{accessLabel("read")}</option>
                      <option value="change">{accessLabel("change")}</option>
                    </Select>
                    <IconButton
                      size="sm"
                      label={t("dataStores.agentRemove", { name: title })}
                      onClick={() => onChange(withDataStoreAccess(toolNames, store, undefined))}
                    >
                      <X aria-hidden="true" />
                    </IconButton>
                  </span>
                ) : (
                  <span className="text-caption text-muted-foreground">{accessLabel(access)}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editable ? (
        <div>
          <Picker
            multiple
            search
            wrapDescriptions
            className="w-120"
            label={t("dataStores.agentChoose")}
            note={t("dataStores.agentChooseNote")}
            onSearchChange={choice.onSearch}
            more={choice.more && { loading: choice.more.loading, onLoad: choice.more.load }}
            options={[
              ...choice.options.map((option) => ({
                value: option.name,
                label: option.title || option.name,
                ...(option.description ? { description: option.description } : {}),
                keywords: option.name,
                leading: <Database aria-hidden="true" />
              })),
              ...(choice.unusable ?? [])
                .filter((option) => !choice.options.some((usable) => usable.name === option.name))
                .map((option) => ({
                  value: option.name,
                  label: option.title || option.name,
                  disabledReason: option.reason,
                  keywords: option.name,
                  leading: <Database aria-hidden="true" />
                }))
            ]}
            value={held.map((entry) => entry.store)}
            onValueChange={(chosen) => onChange(withChosenDataStores(toolNames, chosen))}
          >
            <PickerButton
              label={t("dataStores.agentSection")}
              placeholder={t("dataStores.agentChoose")}
              value={undefined}
            />
          </Picker>
        </div>
      ) : null}
      <p className="text-caption text-muted-foreground">{t("dataStores.agentRightsNote")}</p>
    </>
  );
}
