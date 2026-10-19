import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { completedOutput, type ApiClient } from "@work-shape/catalyst-api-client";
import {
  Banner,
  Button,
  Field,
  Input,
  Picker,
  SkeletonList,
  Switch
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";

export function DataScopes({
  client,
  userId,
  users
}: {
  client: ApiClient;
  userId: string;
  users: readonly { id: string; displayLabel: string }[] | undefined;
}) {
  const { t } = useTranslation();
  const [holderKind, setHolderKind] = useState<"user" | "group" | "service_principal">("user");
  const [holderId, setHolderId] = useState(userId);
  const [values, setValues] = useState<string>();
  const [all, setAll] = useState<boolean>();
  const [deny, setDeny] = useState(false);
  const query = useQuery({
    queryKey: ["data-scopes", userId, holderKind, holderId],
    queryFn: () => client.scope_assignments.list({ query: { holderKind, holderId } }),
    enabled: holderId.length > 0,
    retry: false
  });
  const save = useMutation({
    mutationFn: async (dimension: string) => {
      completedOutput(
        await client.scope_assignments.set({
          body: {
            dimension,
            holderKind,
            holderId,
            effect: deny ? "deny" : "allow",
            values:
              (all ??
              query.data?.assignments.find(
                (row) => row.dimension === dimension && row.effect === (deny ? "deny" : "allow")
              )?.values === "all")
                ? "all"
                : (values ?? savedValues(dimension))
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean)
          }
        })
      );
      await query.refetch();
    }
  });
  const currentRow = (dimension: string) =>
    query.data?.assignments.find(
      (row) => row.dimension === dimension && row.effect === (deny ? "deny" : "allow")
    );
  const savedValues = (dimension: string) => {
    const saved = currentRow(dimension)?.values;
    return saved === "all" || saved === undefined ? "" : saved.join(", ");
  };
  const dimensions = Object.entries(query.data?.dimensions ?? {});
  return (
    <section className="grid gap-4">
      <Picker
        label={t("access.scopeHolderKind")}
        value={holderKind}
        onValueChange={(value) => {
          if (value === "user" || value === "group" || value === "service_principal") {
            setValues(undefined);
            setAll(undefined);
            setDeny(false);
            save.reset();
            setHolderKind(value);
            setHolderId(value === "user" ? userId : "");
          }
        }}
        options={[
          { value: "user", label: t("access.scopePerson") },
          { value: "group", label: t("access.scopeGroup") },
          { value: "service_principal", label: t("access.scopePrincipal") }
        ]}
      >
        <Button variant="outline">{t("access.scopeHolderKind")}</Button>
      </Picker>
      {holderKind === "user" ? (
        <Picker
          label={t("access.scopePerson")}
          value={holderId}
          onValueChange={(value) => {
            setValues(undefined);
            setAll(undefined);
            setDeny(false);
            save.reset();
            setHolderId(value);
          }}
          options={(users ?? []).map((user) => ({ value: user.id, label: user.displayLabel }))}
        >
          <Button variant="outline">
            {users?.find((user) => user.id === holderId)?.displayLabel ?? t("access.scopePerson")}
          </Button>
        </Picker>
      ) : (
        <Field label={t("access.scopeHolder")}>
          <Input value={holderId} onChange={(event) => setHolderId(event.target.value)} />
        </Field>
      )}
      {query.isPending && holderId && <SkeletonList />}
      {query.isError && <Banner tone="danger">{t("access.scopesLoadFailed")}</Banner>}
      {dimensions.map(([dimension, definition]) => (
        <div key={dimension} className="grid gap-3">
          <h2>{definition.label}</h2>
          {!((query.data?.effective?.[dimension] ?? []).length > 0) && (
            <Banner tone="info">{t("access.scopeUnassigned", { scope: definition.label })}</Banner>
          )}
          {query.data?.assignments
            .filter((row) => row.dimension === dimension)
            .map((row) => (
              <p key={row.effect}>
                {row.effect === "deny" ? t("access.scopeRevoked") : t("access.scopeAssigned")}:{" "}
                {row.values === "all" ? t("access.scopeAll") : row.values.join(", ")}
              </p>
            ))}
          <Field label={t("access.scopeValues")}>
            <Input
              value={values ?? savedValues(dimension)}
              disabled={all ?? currentRow(dimension)?.values === "all"}
              onChange={(event) => setValues(event.target.value)}
            />
          </Field>
          <Field label={t("access.scopeAll")}>
            <Switch
              checked={all ?? currentRow(dimension)?.values === "all"}
              onCheckedChange={setAll}
            />
          </Field>
          <Field label={t("access.scopeRevoked")}>
            <Switch
              checked={deny}
              onCheckedChange={(value) => {
                setValues(undefined);
                setAll(undefined);
                setDeny(value);
                save.reset();
              }}
            />
          </Field>
          <Button disabled={save.isPending} onClick={() => save.mutate(dimension)}>
            {t("access.scopeSave")}
          </Button>
          {save.isError && <Banner tone="danger">{t("access.scopesSaveFailed")}</Banner>}
          {save.isSuccess && <p>{t("access.scopesSaved")}</p>}
        </div>
      ))}
      {query.data && dimensions.length === 0 && <p>{t("access.scopesNone")}</p>}
    </section>
  );
}
