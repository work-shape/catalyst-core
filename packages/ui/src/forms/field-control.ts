import { createContext, useContext } from "react";

/** What a Field hands to the control inside it. */
export interface FieldControlContextValue {
  id: string;
  /** The id of the hint or the error under the control, when one shows. */
  messageId: string | undefined;
  invalid: boolean;
  required: boolean;
}

export const FieldControlContext = createContext<FieldControlContextValue | undefined>(undefined);

interface OwnControlProps {
  id?: string;
  required?: boolean;
  invalid?: boolean;
  "aria-describedby"?: string;
}

interface FieldControlAttributes {
  id: string | undefined;
  required: boolean | undefined;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
}

/**
 * The attributes that tie a control to the Field around it: the id its label points at, the
 * message that describes it, and whether it is required or wrong. What the caller sets on the
 * control itself wins, and outside a Field the control keeps exactly what it was given.
 */
export function useFieldControl(own: OwnControlProps): FieldControlAttributes {
  const field = useContext(FieldControlContext);
  const describedBy = [own["aria-describedby"], field?.messageId].filter((id) => id !== undefined);
  return {
    id: own.id ?? field?.id,
    required: own.required ?? field?.required,
    "aria-describedby": describedBy.length > 0 ? describedBy.join(" ") : undefined,
    "aria-invalid": (own.invalid ?? false) || (field?.invalid ?? false) || undefined
  };
}
