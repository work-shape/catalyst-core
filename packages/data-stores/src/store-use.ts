import {
  DATA_STORE_ACTIONS,
  DATA_STORE_OPERATION_PREFIX,
  DATA_STORE_OPERATION_RIGHTS,
  DATA_STORE_OPERATION_VERBS,
  parseConnectionOperationName
} from "@work-shape/catalyst-core";

/** What a published definition does with the store, and the Connections it calls. */
export interface StoreUse {
  title: string;
  reads: boolean;
  writes: boolean;
  connections: readonly string[];
  knowledge?: readonly string[];
}

/** Whether an operation of the store adds rows: one that needs more than the right to read. */
function verbWrites(verb: string): boolean {
  if (verb === "records.propose") return true;
  // Reading what waits in "Prüfen" needs `data_store.records`, and still writes nothing.
  if (verb === "records.flagged") return false;
  const known = DATA_STORE_OPERATION_VERBS.find((candidate) => candidate === verb);
  return known !== undefined && DATA_STORE_OPERATION_RIGHTS[known] !== DATA_STORE_ACTIONS.read;
}

/** What a definition that calls these operations does with the store, or nothing. */
export function useOfOperations(
  operations: readonly string[],
  store: string,
  title: string
): StoreUse | undefined {
  const prefix = `${DATA_STORE_OPERATION_PREFIX}${store}.`;
  const verbs = operations.flatMap((operation) =>
    operation.startsWith(prefix) ? [operation.slice(prefix.length)] : []
  );
  if (verbs.length === 0) return undefined;
  return {
    title,
    reads: verbs.some((verb) => !verbWrites(verb)),
    writes: verbs.some(verbWrites),
    connections: connectionsOf(operations),
    knowledge: [
      ...new Set(
        operations.flatMap((operation) => {
          const [prefix, name] = operation.split(".");
          return prefix === "knowledge" && name ? [name] : [];
        })
      )
    ]
  };
}

/** The Connections whose operations are named, each once, in the order they are first named. */
function connectionsOf(operations: readonly string[]): string[] {
  return [
    ...new Set(
      operations.flatMap((operation) => {
        const parsed = parseConnectionOperationName(operation);
        return parsed ? [parsed.connection] : [];
      })
    )
  ];
}
