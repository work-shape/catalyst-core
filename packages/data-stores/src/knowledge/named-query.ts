import { z } from "zod";
import { AppError, type JsonObject } from "@work-shape/catalyst-core";
import { compileSqlStatement, bindSqlActionParameters } from "@work-shape/catalyst-app-build";
import { queryInputSchema, queryParameterValueSchema } from "../query";

/** A named query's parameter object never contains a viewer value. */
export const knowledgeQueryInputSchema = z
  .strictObject({
    sql: queryInputSchema.shape.sql.optional(),
    query: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/u)
      .optional(),
    parameters: z
      .union([
        queryInputSchema.shape.parameters.unwrap(),
        z.record(z.string(), queryParameterValueSchema)
      ])
      .optional()
  })
  .refine(
    (input) => (input.sql === undefined) !== (input.query === undefined),
    "Give either sql or a named query"
  );

export function compiledNamedQuery(query: { name: string; sql: string }) {
  const compiled = compileSqlStatement(query.sql, "reading");
  if ("faults" in compiled || compiled.effect !== "reading")
    throw new AppError(
      "VALIDATION_FAILED",
      `Named query '${query.name}' is invalid: ${"faults" in compiled ? compiled.faults[0]?.message : "a reading statement is required"}`,
      { reason: "named_query_invalid" }
    );
  return compiled;
}

export function namedQueryStatement(query: { name: string; sql: string }, parameters: JsonObject) {
  const compiled = compiledNamedQuery(query);
  const allowed = new Set(compiled.parameters.map((parameter) => parameter.name));
  if (
    Object.keys(parameters).some((name) => !allowed.has(name)) ||
    compiled.parameters.some(
      (parameter) => !parameter.optional && !Object.hasOwn(parameters, parameter.name)
    )
  )
    throw new AppError(
      "VALIDATION_FAILED",
      `Named query '${query.name}' needs exactly its declared parameters`,
      { reason: "named_query_parameters" }
    );
  return {
    sql: compiled.statement,
    parameters: bindSqlActionParameters(compiled.parameters, parameters)
  };
}
