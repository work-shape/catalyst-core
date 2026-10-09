import {
  apiOperations,
  type ApiOperationName,
  type Operation,
  type OperationPathParamName
} from "@vivd-catalyst/api-contract";
import type { z } from "zod";
import { ApiError, malformedResponseError, transportError } from "./errors";
import { readServerSentEvents } from "./server-sent-events";
import {
  createApiTransport,
  type ApiClientOptions,
  type ApiTransport,
  type OperationRequest
} from "./transport";

export type { ApiClientOptions };

type Catalog = typeof apiOperations;

/** `{ key: Value }`, with the key optional when an empty value would do. */
type Part<Key extends string, Value> =
  Record<never, never> extends Value ? Partial<Record<Key, Value>> : Record<Key, Value>;

type ParamsPart<Path extends string> = [OperationPathParamName<Path>] extends [never]
  ? unknown
  : { params: Record<OperationPathParamName<Path>, string> };

/** The keys a query schema accepts, with the types its values have once they are parsed. */
type QueryValues<Schema extends z.ZodType> = {
  [Key in keyof z.input<Schema>]: Key extends keyof z.output<Schema>
    ? z.output<Schema>[Key]
    : never;
};

type QueryPart<Op> = Op extends { query: infer Schema extends z.ZodType }
  ? Part<"query", QueryValues<Schema>>
  : unknown;

type BodyPart<Op> = Op extends { multipart: true }
  ? { file: File }
  : Op extends { body: infer Schema extends z.ZodType }
    ? { body: z.input<Schema> }
    : unknown;

type ControlPart<Op extends Operation> = {
  signal?: AbortSignal;
} & (Op["response"] extends { kind: "sse" }
  ? {
      /** Called when the server has nothing after the given position and sends no stream. */
      onCaughtUp?: () => void;
    }
  : unknown);

type InputOf<Op extends Operation> = ParamsPart<Op["path"]> &
  QueryPart<Op> &
  BodyPart<Op> &
  ControlPart<Op>;

type OutputOf<Op extends Operation> = Op["response"] extends {
  kind: "sse";
  schema: infer Schema extends z.ZodType;
}
  ? AsyncIterable<z.output<Schema>>
  : Op["response"] extends { schema: infer Schema extends z.ZodType }
    ? Promise<z.output<Schema>>
    : Promise<Blob>;

/** What the method of a catalog operation takes: `params`, `query`, `body` or `file`, `signal`. */
export type OperationInput<Name extends ApiOperationName> = InputOf<Catalog[Name]>;

type OperationMethod<Op extends Operation> =
  Record<never, never> extends InputOf<Op>
    ? (input?: InputOf<Op>) => OutputOf<Op>
    : (input: InputOf<Op>) => OutputOf<Op>;

type FirstSegment<Id extends string> = Id extends `${infer First}.${string}` ? First : Id;
type AfterSegment<Id extends string, First extends string> = Id extends `${First}.${infer Rest}`
  ? Rest
  : never;

/** One method per operation, nested by the segments of its id: `conversations.runs.start`. */
type MethodTree<Ids extends string, Prefix extends string = ""> = {
  [Segment in FirstSegment<Ids>]: `${Prefix}${Segment}` extends ApiOperationName
    ? OperationMethod<Catalog[`${Prefix}${Segment}`]>
    : MethodTree<AfterSegment<Ids, Segment>, `${Prefix}${Segment}.`>;
};

export type ApiOperationMethods = MethodTree<ApiOperationName>;

export type ApiClient = ApiOperationMethods & {
  /** Whether the browser itself may fetch a file by URL, which only a session cookie allows. */
  browserManagedDownloads: boolean;
  /** The absolute URL of an operation, for a link or an element that loads it itself. */
  urlFor<Name extends ApiOperationName>(
    name: Name,
    input: Pick<OperationInput<Name>, Extract<keyof OperationInput<Name>, "params" | "query">>
  ): string;
};

/**
 * The first-party client. Its methods are not written down anywhere: each operation of the
 * catalog becomes one method, and every method goes through the same call.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const transport = createApiTransport(options);
  const methods = buildMethodTree((operation, request) =>
    callOperation(transport, operation, request)
  );
  if (!hasEveryOperation(methods)) {
    throw new Error("The client's methods do not cover the operation catalog");
  }
  return Object.assign(methods, {
    browserManagedDownloads: transport.browserManagedDownloads,
    urlFor: (name: ApiOperationName, input: Pick<OperationRequest, "params" | "query">) =>
      transport.urlFor(apiOperations[name], input)
  });
}

/** As many items as a list operation hands out at once. */
const LARGEST_PAGE = 200;

/**
 * Reads a list operation to its end, one largest page after the other:
 * `listAll((paging) => client.users.list({ query: paging }))`. One call of a list method answers
 * a single page, and a screen that shows a whole list must not stop at the first.
 */
export async function listAll<Item>(
  readPage: (paging: {
    limit: number;
    cursor?: string;
  }) => Promise<{ items: Item[]; nextCursor?: string }>
): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: string | undefined;
  do {
    const page = await readPage({ limit: LARGEST_PAGE, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

type Call = (operation: Operation, request: OperationRequest) => unknown;
type Method = (request?: OperationRequest) => unknown;
interface MethodNode {
  [segment: string]: MethodNode | Method;
}

function buildMethodTree(call: Call): MethodNode {
  const root: MethodNode = {};
  for (const operation of Object.values<Operation>(apiOperations)) {
    const segments = operation.id.split(".");
    const name = segments.pop() ?? "";
    let node = root;
    for (const segment of segments) {
      const next = (node[segment] ??= {});
      if (typeof next === "function") {
        throw new Error(`Operation id "${operation.id}" continues the id of another operation`);
      }
      node = next;
    }
    if (node[name]) {
      throw new Error(`Operation id "${operation.id}" is the start of another operation's id`);
    }
    node[name] = (request = {}) => call(operation, request);
  }
  return root;
}

/** Proves at run time what the type derives: every id of the catalog leads to a method. */
function hasEveryOperation(tree: MethodNode): tree is MethodNode & ApiOperationMethods {
  return Object.keys(apiOperations).every((id) => {
    let node: MethodNode | Method | undefined = tree;
    for (const segment of id.split(".")) {
      node = typeof node === "object" ? node[segment] : undefined;
    }
    return typeof node === "function";
  });
}

function callOperation(
  transport: ApiTransport,
  operation: Operation,
  request: OperationRequest
): AsyncIterable<unknown> | Promise<unknown> {
  const { response } = operation;
  if (response.kind === "sse") {
    return streamEvents(transport, operation, response.schema, request);
  }
  if (response.kind === "blob") {
    return transport
      .send(operation, request)
      .then((answer) => readBody(() => answer.blob(), request));
  }
  return transport
    .send(operation, request)
    .then(async (answer) =>
      parseJson(await readBody(() => answer.text(), request), response.schema, answer.status)
    );
}

async function* streamEvents(
  transport: ApiTransport,
  operation: Operation,
  schema: z.ZodType,
  request: OperationRequest
): AsyncGenerator<unknown, void, undefined> {
  const answer = await transport.send(operation, request);
  if (answer.status === 204) {
    request.onCaughtUp?.();
    return;
  }
  if (!answer.body) {
    return;
  }
  try {
    for await (const data of readServerSentEvents(answer.body)) {
      yield parseJson(data, schema, answer.status);
    }
  } catch (error) {
    throw asCallFailure(error, request);
  }
}

async function readBody<Body>(read: () => Promise<Body>, request: OperationRequest) {
  try {
    return await read();
  } catch (error) {
    throw asCallFailure(error, request);
  }
}

/** An abort stays the caller's own abort; anything else that cuts an answer is a failed call. */
function asCallFailure(error: unknown, request: OperationRequest): unknown {
  return error instanceof ApiError || request.signal?.aborted ? error : transportError(error);
}

function parseJson(text: string, schema: z.ZodType, status: number): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw malformedResponseError(status, error);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw malformedResponseError(status, parsed.error);
  }
  return parsed.data;
}
