import {
  Banner,
  Button,
  Chip,
  Field,
  Picker,
  Switch,
  type PickerOption
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";

/** From this many entries on, a tool or model picker shows its search field. */
const LIST_SEARCH_FROM_COUNT = 8;

/**
 * One build limit, of a Namespace or a workspace: a switch, and while it is on, the picker
 * with what is chosen.
 * On with nothing chosen is a state of its own, and the hint says what it means.
 */
export function LimitedList({
  label,
  offHint,
  emptyHint,
  listedHint,
  chooseLabel,
  limited,
  chosen,
  options,
  optionsReady,
  onLimitedChange,
  onChosenChange
}: {
  label: string;
  offHint: string;
  emptyHint: string;
  /** What a list with entries means, where that needs saying. */
  listedHint?: string;
  chooseLabel: string;
  limited: boolean;
  chosen: readonly string[];
  options: readonly PickerOption[];
  optionsReady: boolean;
  onLimitedChange(limited: boolean): void;
  onChosenChange(chosen: string[]): void;
}) {
  const { t } = useTranslation();
  // A chosen entry the instance no longer offers stays visible, so it can be removed.
  const shownOptions = [
    ...options,
    ...chosen
      .filter((value) => !options.some((option) => option.value === value))
      .map((value) => ({ value, label: value }))
  ];
  return (
    <div className="grid gap-2">
      <Field layout="inline" label={label} hint={limited ? undefined : offHint}>
        <Switch checked={limited} onCheckedChange={onLimitedChange} />
      </Field>
      {limited ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <Picker
              multiple
              search={shownOptions.length >= LIST_SEARCH_FROM_COUNT}
              options={shownOptions}
              value={chosen}
              onValueChange={onChosenChange}
            >
              <Button variant="outline" size="sm" disabled={!optionsReady}>
                {chooseLabel}
              </Button>
            </Picker>
            <span className="text-caption text-muted-foreground">
              {t("access.chosenCount", { count: chosen.length, total: shownOptions.length })}
            </span>
          </div>
          {chosen.length === 0 ? (
            <Banner tone="warning" layout="line">
              {emptyHint}
            </Banner>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {chosen.map((value) => (
                  <Chip
                    key={value}
                    size="sm"
                    onRemove={() => onChosenChange(chosen.filter((other) => other !== value))}
                  >
                    {value}
                  </Chip>
                ))}
              </div>
              {listedHint === undefined ? null : (
                <p className="text-caption text-muted-foreground">{listedHint}</p>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** What a build limit comes to: no limit, nothing allowed, or how many entries. */
export function listSummary(
  list: readonly string[] | null,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  if (list === null) {
    return t("access.listNoLimit");
  }
  return list.length === 0
    ? t("access.listNoneAllowed")
    : t("access.listListed", { count: list.length });
}
