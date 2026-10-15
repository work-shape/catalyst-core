import { useState, type ReactNode } from "react";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "../structure/disclosure";
import { Field } from "./field";
import { Input } from "./input";

/** What a `NameWithAddress` holds: the name, and the address once it was typed by hand. */
export interface NameAndAddress {
  name: string;
  /** Absent while the address follows the name. */
  typedAddress?: string;
}

/** The address of a value: as typed, or made from the name until somebody types one. */
export function addressOf(value: NameAndAddress, derive: (name: string) => string): string {
  return value.typedAddress ?? derive(value.name);
}

/** What the check of the address found: nothing asked yet, under way, free, or why not. */
export type AddressCheck =
  | { state: "unchecked" }
  | { state: "checking" }
  | { state: "free" }
  | { state: "refused"; reason: ReactNode };

export interface NameWithAddressProps {
  value: NameAndAddress;
  onChange(value: NameAndAddress): void;
  /** Makes the address from the name, as long as nobody typed one. */
  derive(name: string): string;
  check: AddressCheck;
  nameLabel: ReactNode;
  addressLabel: ReactNode;
  /** The line the address is folded under, such as "Advanced". */
  advancedLabel: ReactNode;
  /** Under the address while nothing is wrong with it, such as the whole address it becomes. */
  addressHint?: ReactNode;
  /** Between the name and the fold: what a person fills in next. */
  children?: ReactNode;
  /** In the fold after the address: what few people change. */
  advanced?: ReactNode;
  /** Opens the fold, such as when a field in `advanced` is wrong. */
  advancedOpen?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}

/**
 * A new thing's name, and the address it is reached by, folded away below. The address
 * follows the name until it is edited. The caller checks it as it changes and hands the
 * answer in as `check`; a refused address opens the fold, so its reason shows while typing, and it stays open.
 */
export function NameWithAddress({
  value,
  onChange,
  derive,
  check,
  nameLabel,
  addressLabel,
  advancedLabel,
  addressHint,
  children,
  advanced,
  advancedOpen = false,
  disabled = false,
  autoFocus = false
}: NameWithAddressProps) {
  const [opened, setOpened] = useState(false);
  const refused = check.state === "refused";
  // A fold opened for a refusal stays open once the address is free again, so it does not
  // jump while the person types.
  if (refused && !opened) setOpened(true);
  return (
    <div className="grid min-w-0 gap-4" data-name-with-address="">
      <Field label={nameLabel} required>
        <Input
          autoFocus={autoFocus}
          value={value.name}
          disabled={disabled}
          data-name-with-address-field="name"
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
      </Field>
      {children}
      <Disclosure
        open={opened || refused || advancedOpen}
        onOpenChange={setOpened}
        disabled={disabled}
      >
        <DisclosureTrigger data-name-with-address-fold="">{advancedLabel}</DisclosureTrigger>
        <DisclosureContent>
          <div className="grid min-w-0 gap-4 pt-2">
            <Field
              label={addressLabel}
              hint={addressHint}
              error={refused ? check.reason : undefined}
              required
            >
              <Input
                size="sm"
                className="font-mono"
                spellCheck={false}
                autoComplete="off"
                value={addressOf(value, derive)}
                disabled={disabled}
                data-name-with-address-field="address"
                data-address-check={check.state}
                onChange={(event) => onChange({ ...value, typedAddress: event.target.value })}
              />
            </Field>
            {advanced}
          </div>
        </DisclosureContent>
      </Disclosure>
    </div>
  );
}
