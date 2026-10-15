import {
  type AssetValidationIssue,
  type ConnectionOperationConfig,
  type ConnectorOperationDescriptor,
  type DeclaredOperationParameter,
  type DeclaredOperations,
  type JsonObject
} from "@work-shape/catalyst-core";
import { measureOutsideJsonSchema, type OutsideSchemaBoundRefusal } from "../json-schema";

// The operations of an `http_api` Connection, as the Connection declares them: what a save
// accepts, and the catalog entry each becomes. Pure: nothing here contacts the outside system.
//
// The first cut reads only (manager, 2026-10-14): method GET and effect `reading`, nothing
// else. A GET is no proof of no side effect, so the effect is declared as for any operation.
// A path is a template relative to the Connection's address. Caller input fills the declared
// path and query parameters and nothing else: never the host, the method, a header or the
// credential.

/** The one method of the first cut. */
const HTTP_API_METHODS = ["GET"] as const;

/** The JSON Schema types a path parameter may have: each is written into the path as text. */
const PATH_PARAMETER_TYPES = ["string", "integer", "number"];
/** The JSON Schema types a query parameter may have: each is written as one query value. */
const QUERY_PARAMETER_TYPES = ["string", "integer", "number", "boolean"];

/**
 * A path as a declaration may write it: from `/`, of the characters a path holds without
 * encoding, `%` escapes, and `{name}` placeholders. No query and no fragment: a query value is
 * a declared parameter.
 */
const PATH_TEMPLATE_PATTERN = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/%{}]*$/u;
const PLACEHOLDER_PATTERN = /\{([^{}]*)\}/gu;

/** The names of the placeholders of a path template, in their order. */
export function pathPlaceholders(path: string): string[] {
  return [...path.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1] ?? "");
}

/**
 * Whether a path segment is `.` or `..` as a URL reads it, where `%2e` in any case is a dot.
 * A URL drops such a segment or climbs one up with it, so the request would leave the
 * declared path, and the base path with it.
 */
export function isDotSegment(segment: string): boolean {
  const decoded = segment.replace(/%2e/giu, ".");
  return decoded === "." || decoded === "..";
}

/** A schema over a bound of the platform, named by the bound's code. */
function schemaRefusal(
  refusal: OutsideSchemaBoundRefusal,
  path: PropertyKey[]
): AssetValidationIssue {
  return {
    message: `${refusal}: the schema is over a bound of what the platform checks (JSON_SCHEMA_MAX_BYTES and the bounds beside it)`,
    path,
    code: refusal
  };
}

/** Why a path template is refused, or nothing. */
function pathIssue(path: string): string | undefined {
  if (!PATH_TEMPLATE_PATTERN.test(path)) {
    return "A path starts with '/' and holds no query, fragment, space or address: a query value is a declared parameter";
  }
  const literal = path.replace(PLACEHOLDER_PATTERN, "x");
  if (/[{}]/u.test(literal)) return "A path writes each placeholder as {name}";
  if (literal.includes("//")) return "A path holds no empty segment ('//')";
  if (literal.split("/").some(isDotSegment)) {
    return "A path holds no '.' or '..' segment, also not written as %2e";
  }
  return undefined;
}

function parameterIssues(
  parameters: Record<string, DeclaredOperationParameter> | undefined,
  field: "pathParams" | "query",
  types: readonly string[]
): AssetValidationIssue[] {
  return Object.entries(parameters ?? {}).flatMap(([name, parameter]) => {
    const issues: AssetValidationIssue[] = [];
    const type = parameter.schema.type;
    if (typeof type !== "string" || !types.includes(type)) {
      issues.push({
        message: `A ${field === "query" ? "query" : "path"} parameter's schema names its 'type', one of: ${types.join(", ")}`,
        path: [field, name, "schema", "type"]
      });
    }
    if (field === "pathParams" && parameter.required !== undefined) {
      issues.push({
        message: "A path parameter is always required, so it names no 'required'",
        path: [field, name, "required"]
      });
    }
    const measured = measureOutsideJsonSchema(parameter.schema);
    if (!measured.ok) {
      issues.push(schemaRefusal(measured.refusal, [field, name, "schema"]));
    }
    return issues;
  });
}

/** Why the placeholders of the path and the declared path parameters do not match. */
function placeholderIssues(
  operation: ConnectionOperationConfig,
  path: string
): AssetValidationIssue[] {
  const placeholders = pathPlaceholders(path);
  const declared = Object.keys(operation.pathParams ?? {});
  const issues: AssetValidationIssue[] = [];
  const seen = new Set<string>();
  for (const placeholder of placeholders) {
    if (seen.has(placeholder)) {
      issues.push({ message: `The path names {${placeholder}} twice`, path: ["path"] });
    }
    seen.add(placeholder);
    if (!declared.includes(placeholder)) {
      issues.push({
        message: `The path names {${placeholder}}, which 'pathParams' does not declare`,
        path: ["path"]
      });
    }
  }
  for (const name of declared.filter((name) => !seen.has(name))) {
    issues.push({
      message: `The path parameter '${name}' has no {${name}} in the path`,
      path: ["pathParams", name]
    });
  }
  for (const name of Object.keys(operation.query ?? {})) {
    if (declared.includes(name)) {
      issues.push({
        message: `'${name}' is declared as a path and as a query parameter`,
        path: ["query", name]
      });
    }
  }
  return issues;
}

/** The input schema an agent, an App or a Workflow fills: the declared parameters and no more. */
function inputSchemaOf(operation: ConnectionOperationConfig): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];
  const add = (name: string, parameter: DeclaredOperationParameter, isRequired: boolean) => {
    properties[name] = {
      ...parameter.schema,
      ...(parameter.description === undefined ? {} : { description: parameter.description })
    };
    if (isRequired) required.push(name);
  };
  for (const [name, parameter] of Object.entries(operation.pathParams ?? {})) {
    add(name, parameter, true);
  }
  for (const [name, parameter] of Object.entries(operation.query ?? {})) {
    add(name, parameter, parameter.required === true);
  }
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false
  };
}

/** The declared operations of `http_api`: what a save refuses, and the catalog entry of each. */
export const httpApiDeclaredOperations: DeclaredOperations = {
  issues(operation) {
    const issues: AssetValidationIssue[] = [];
    if (operation.method === undefined) {
      issues.push({ message: "An operation names its method: GET", path: ["method"] });
    } else if (!HTTP_API_METHODS.some((method) => method === operation.method)) {
      issues.push({
        message: `This first cut of http_api reads only: the method is GET, not '${operation.method}'`,
        path: ["method"]
      });
    }
    if (operation.effect !== "reading") {
      issues.push({
        message: "This first cut of http_api reads only: the effect is 'reading'",
        path: ["effect"]
      });
    }
    if (operation.description === undefined) {
      issues.push({
        message: "An operation says in 'description' what it reads and when to call it",
        path: ["description"]
      });
    }
    if (operation.path === undefined) {
      issues.push({ message: "An operation names its 'path'", path: ["path"] });
    } else {
      const refused = pathIssue(operation.path);
      if (refused !== undefined) issues.push({ message: refused, path: ["path"] });
      else issues.push(...placeholderIssues(operation, operation.path));
    }
    issues.push(
      ...parameterIssues(operation.pathParams, "pathParams", PATH_PARAMETER_TYPES),
      ...parameterIssues(operation.query, "query", QUERY_PARAMETER_TYPES)
    );
    if (issues.length > 0) return issues;
    const measured = measureOutsideJsonSchema(inputSchemaOf(operation));
    return measured.ok ? [] : [schemaRefusal(measured.refusal, [])];
  },

  describe(operation): ConnectorOperationDescriptor {
    return {
      name: operation.name,
      description: operation.description ?? "",
      inputSchema: inputSchemaOf(operation),
      proposedEffect: "reading"
    };
  }
};
