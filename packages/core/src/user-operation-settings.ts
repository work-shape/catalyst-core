import type { ClientInstanceId } from "./ids";
import type { PersonPolicySetting } from "./operation-policy";
import type { ISODateString } from "./time";

/** One person's own value for one operation (OP-6). */
export interface UserOperationSetting {
  operation: string;
  value: PersonPolicySetting;
  updatedAt: ISODateString;
}

/**
 * The confirmation settings of people, per person and operation. Only the person reads and
 * changes their own: every method takes the person as derived from the caller, never from a
 * caller's parameter. A person's settings go with their account.
 */
export interface UserOperationSettingStore {
  list(input: {
    clientInstanceId: ClientInstanceId;
    userId: string;
  }): Promise<UserOperationSetting[]>;
  get(input: {
    clientInstanceId: ClientInstanceId;
    userId: string;
    operation: string;
  }): Promise<PersonPolicySetting | undefined>;
  /** Sets the value, or removes the setting with `null`. Answers the value it had before. */
  set(input: {
    clientInstanceId: ClientInstanceId;
    userId: string;
    operation: string;
    value: PersonPolicySetting | null;
    at: ISODateString;
  }): Promise<{ previous: PersonPolicySetting | undefined }>;
}
