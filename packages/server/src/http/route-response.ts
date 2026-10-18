import type { Operation } from "@work-shape/catalyst-api-contract";
import type { z } from "zod";
import type { DownloadAnswer } from "./download";

/**
 * The shape a response schema accepts, with every set of literal values widened to its
 * primitive. The compiler checks structure and optionality against it. Value sets, where the
 * product's own types are wider than the contract's, are checked on every call at run time.
 */
type ResponseShape<Value> = Value extends string
  ? string
  : Value extends number
    ? number
    : Value extends boolean
      ? boolean
      : Value extends readonly (infer Item)[]
        ? ResponseShape<Item>[]
        : Value extends object
          ? { [Key in keyof Value]: ResponseShape<Value[Key]> }
          : Value;

/** What a probe returns while the instance cannot serve. */
type UnavailableResult<Response> = Response extends {
  unavailable: infer Unavailable extends z.ZodType;
}
  ? ResponseShape<z.input<Unavailable>>
  : never;

/**
 * A JSON operation returns its payload; a stream or a file is sent by the handler itself, which
 * then answers `Sent`.
 */
export type RouteResultOr<Op extends Operation, Sent> = Op["response"] extends {
  kind: "json";
  schema: infer Schema extends z.ZodType;
}
  ? ResponseShape<z.input<Schema>> | UnavailableResult<Op["response"]>
  : Op["response"] extends { kind: "page"; schema: infer Schema extends z.ZodType }
    ? z.input<Schema> extends { items: infer Items }
      ? ResponseShape<Items>
      : never
    : Op["response"] extends { kind: "redirect"; schema: infer Schema extends z.ZodType }
      ? z.input<Schema>
      : Sent;

export type OperationResponseResult<Op extends Operation, Sent> = Op["response"] extends {
  kind: "blob";
}
  ? DownloadAnswer
  : RouteResultOr<Op, Sent>;
