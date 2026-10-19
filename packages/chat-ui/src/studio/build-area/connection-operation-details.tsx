import type { ConnectionOperationDetail } from "@work-shape/catalyst-api-client";
import {
  Badge,
  Chip,
  CodeBlock,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  KeyValue,
  KeyValueList,
  List,
  ListRow
} from "@work-shape/catalyst-ui";
import {
  useTranslation,
  type TranslationContextValue,
  type TranslationKey
} from "../../shared/i18n";
import {
  httpOperationDeclaration,
  mcpOperationDeclaration,
  type OperationDeclaration,
  type OperationParameter,
  type ParameterConstraintKey
} from "./connection-operation-schema";

// What one accepted operation calls and what it takes, in words: the request of a REST API as
// its definition declares it, or the tool of an MCP server with the input its server named.
// The declaration itself stands under "Technical details". Every text here comes from outside
// the instance and is shown as text.

/** The JSON types a person reads in words. Any other type keeps its name. */
const TYPE_WORDS: Record<string, TranslationKey> = {
  string: "connectionPage.typeString",
  integer: "connectionPage.typeInteger",
  number: "connectionPage.typeNumber",
  boolean: "connectionPage.typeBoolean",
  array: "connectionPage.typeArray",
  object: "connectionPage.typeObject",
  null: "connectionPage.typeNull"
};

const CONSTRAINT_WORDS: Record<ParameterConstraintKey, TranslationKey> = {
  minimum: "connectionPage.minimum",
  exclusiveMinimum: "connectionPage.exclusiveMinimum",
  maximum: "connectionPage.maximum",
  exclusiveMaximum: "connectionPage.exclusiveMaximum",
  multipleOf: "connectionPage.multipleOf",
  minLength: "connectionPage.minLength",
  maxLength: "connectionPage.maxLength",
  minItems: "connectionPage.minItems",
  maxItems: "connectionPage.maxItems",
  format: "connectionPage.format",
  pattern: "connectionPage.pattern",
  default: "connectionPage.default"
};

type Translate = TranslationContextValue["t"];

/** One type in words, a list with the types of its items. */
function typeWord(type: string, itemTypes: readonly string[], t: Translate): string {
  const key = TYPE_WORDS[type];
  const word = key === undefined ? type : t(key);
  return type === "array" && itemTypes.length > 0
    ? t("connectionPage.typeListOf", { type: typesInWords(itemTypes, [], t) })
    : word;
}

/** The types a value may have, in words: "Text or Number". Empty where the schema names none. */
export function typesInWords(
  types: readonly string[],
  itemTypes: readonly string[],
  t: Translate
): string {
  return types
    .map((type) => typeWord(type, itemTypes, t))
    .reduce(
      (first, second) => (first === "" ? second : t("connectionPage.typeOr", { first, second })),
      ""
    );
}

/** The lines under one parameter: what it is for, the values it allows, its constraints. */
function parameterLines(parameter: OperationParameter, locale: string, t: Translate): string[] {
  const listed = (values: readonly string[], more: boolean) => {
    if (values.length === 0) return undefined;
    const text = new Intl.ListFormat(locale, { type: "disjunction" }).format(values);
    return more ? t("connectionPage.moreValues", { values: text }) : text;
  };
  const values = listed(parameter.values, parameter.moreValues);
  const entries = listed(parameter.itemValues, parameter.moreItemValues);
  return [
    ...(parameter.description === undefined ? [] : [parameter.description]),
    ...(values === undefined ? [] : [t("connectionPage.allowedValues", { values })]),
    ...(entries === undefined ? [] : [t("connectionPage.allowedEntries", { values: entries })]),
    ...(parameter.constraints.length === 0
      ? []
      : [
          parameter.constraints
            .map(({ key, value }) => t(CONSTRAINT_WORDS[key], { value }))
            .join(" · ")
        ])
  ];
}

/** The declaration of an operation, as far as the page knows it. */
export function operationDeclarationOf(
  config: Record<string, unknown>,
  operation: Pick<ConnectionOperationDetail, "name" | "inputSchema">
): OperationDeclaration | undefined {
  return config.connectorType === "http_api"
    ? httpOperationDeclaration(config, operation.name)
    : mcpOperationDeclaration(operation.inputSchema);
}

export function OperationDetails({
  operation,
  config
}: {
  operation: ConnectionOperationDetail;
  /** The Connection's definition, which holds a REST API's declarations. */
  config: Record<string, unknown>;
}) {
  const { locale, t } = useTranslation();
  const declaration = operationDeclarationOf(config, operation);
  const rest = config.connectorType === "http_api";
  return (
    <div className="grid min-w-0 gap-2" data-connection-operation-details={operation.name}>
      <KeyValueList>
        {declaration?.request ? (
          <KeyValue label={t("connectionPage.request")}>
            <code className="font-mono text-code break-all" data-connection-request="">
              {declaration.request.method} {declaration.request.path}
            </code>
          </KeyValue>
        ) : rest ? null : (
          <KeyValue label={t("connectionPage.mcpTool")}>
            <code className="font-mono text-code break-all">{operation.name}</code>
          </KeyValue>
        )}
      </KeyValueList>
      {/* A server's schema is the one it describes now; a REST API's is the accepted definition. */}
      {!rest && declaration !== undefined && operation.status === "needs_review" ? (
        <p className="text-caption text-muted-foreground" data-connection-inputs-unaccepted="">
          {t("connectionPage.inputsUnaccepted")}
        </p>
      ) : null}
      {declaration === undefined ? (
        rest ? null : (
          <p className="text-caption text-muted-foreground">{t("connectionPage.noSchema")}</p>
        )
      ) : declaration.parameters.length === 0 ? (
        declaration.takesNothing ? (
          <p className="text-caption text-muted-foreground" data-connection-no-inputs="">
            {t("connectionPage.noInputs")}
          </p>
        ) : (
          <p className="text-caption text-muted-foreground" data-connection-inputs-elsewhere="">
            {t("connectionPage.inputsElsewhere")}
          </p>
        )
      ) : (
        <List aria-label={t("connectionPage.inputs")}>
          {declaration.parameters.map((parameter) => {
            const type = typesInWords(parameter.types, parameter.itemTypes, t);
            const lines = parameterLines(parameter, locale, t);
            return (
              <ListRow
                key={`${parameter.location}:${parameter.name}`}
                size="compact"
                data-connection-parameter={parameter.name}
                title={<code className="font-mono text-code break-all">{parameter.name}</code>}
                chips={
                  <>
                    {type === "" ? null : <Chip size="sm">{type}</Chip>}
                    {parameter.location === "input" ? null : (
                      <Chip size="sm">
                        {t(
                          parameter.location === "path"
                            ? "connectionPage.locationPath"
                            : "connectionPage.locationQuery"
                        )}
                      </Chip>
                    )}
                    <Badge size="sm" tone={parameter.required ? "warning" : "neutral"}>
                      {t(
                        parameter.required ? "connectionPage.required" : "connectionPage.optional"
                      )}
                    </Badge>
                  </>
                }
                description={
                  lines.length === 0 ? undefined : (
                    <span className="grid gap-0.5 break-words whitespace-pre-line">
                      {lines.map((line, index) => (
                        <span key={index}>{line}</span>
                      ))}
                    </span>
                  )
                }
                descriptionWraps
              />
            );
          })}
        </List>
      )}
      {declaration?.moreParameters ? (
        <p className="text-caption text-muted-foreground">{t("connectionPage.moreInputs")}</p>
      ) : null}
      {declaration && declaration.raw !== "" ? (
        <Disclosure data-connection-declaration={operation.name}>
          <DisclosureTrigger>{t("connectionCreate.details")}</DisclosureTrigger>
          <DisclosureContent>
            {declaration.rawCut ? (
              <p className="text-caption text-muted-foreground" data-connection-declaration-cut="">
                {t("connectionPage.declarationCut", { count: declaration.raw.length })}
              </p>
            ) : null}
            <CodeBlock code={declaration.raw} label="JSON" wrap maxLines={24} />
          </DisclosureContent>
        </Disclosure>
      ) : null}
    </div>
  );
}
