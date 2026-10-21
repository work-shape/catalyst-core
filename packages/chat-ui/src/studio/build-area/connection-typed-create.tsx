import { ArrowLeft } from "lucide-react";
import { useRef, useState } from "react";
import { CONNECTION_ASSET_KIND, assetAddressFromName } from "@work-shape/catalyst-core";
import {
  Banner,
  Button,
  Dialog,
  Field,
  FormNotice,
  IconButton,
  Input,
  NameWithAddress,
  Step,
  Steps,
  Textarea
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { BuildCreateDialogProps } from "./build-asset-kind";
import { readBuildRefusal } from "./build-refusals";
import {
  connectConnection,
  type ConnectMemory,
  type ConnectOutcome,
  type ConnectStep,
  type ConnectStepState
} from "./connection-connect";
import { connectionWriteErrors } from "./connection-refusals";
import type { ConnectionSource } from "./connection-source";
import {
  offerText,
  typedComplete,
  typedConnectionConfig,
  typedSecret,
  type ConnectorTypeOffer,
  type TypedValues
} from "./connection-typed-model";
import { addressBlocksCreate, useAddressCheck } from "./name-check";
import { RefusalDetail } from "./refusal-notice";

// The New connection dialog for a Connector type that declares its own form, such as a
// document source: the name, the fields the type asks for, and Verbinden. Verbinden writes the
// definition, sends the secret and runs the type's test; nothing is discovered.

type Errors = Partial<Record<"id" | "secret" | "general", string>> & { detail?: string };

export function TypedConnectionCreate({
  offer,
  source,
  checkName,
  put,
  onBack,
  onClose,
  onCreated
}: Pick<BuildCreateDialogProps, "checkName" | "put" | "onClose" | "onCreated"> & {
  offer: ConnectorTypeOffer;
  source: ConnectionSource;
  onBack(): void;
}) {
  const { locale, t } = useTranslation();
  const service = offerText(offer.service ?? offer.title, locale);
  const [title, setTitle] = useState("");
  const [typedId, setTypedId] = useState<string>();
  const [description, setDescription] = useState("");
  const [values, setValues] = useState<TypedValues>({});
  const [errors, setErrors] = useState<Errors>({});
  const [steps, setSteps] = useState<{ step: ConnectStep; state: ConnectStepState }[]>([]);
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState(false);
  const memory = useRef<ConnectMemory>({});

  const name = (typedId ?? assetAddressFromName(title, CONNECTION_ASSET_KIND)).trim();
  const created = memory.current.revision !== undefined;
  const check = useAddressCheck(created ? undefined : checkName, name);
  const complete =
    title.trim() !== "" &&
    name !== "" &&
    typedComplete(offer, values) &&
    !addressBlocksCreate(check);
  const secretIndex = offer.fields.findIndex((field) => field.secret);

  const connect = async () => {
    const key = typedSecret(offer, values);
    const config = typedConnectionConfig(offer, { name, title: title.trim(), description }, values);
    setBusy(true);
    setErrors({});
    const order: ConnectStep[] = ["server", ...(key === "" ? [] : (["key"] as const))];
    setSteps(order.map((step) => ({ step, state: step === "server" ? "running" : "queued" })));
    const outcome = await connectConnection(
      {
        put: async (definition, expectedRevision) =>
          (await put({ name, config: definition, expectedRevision })).revision,
        setSecret: (value, expectedVersion) => source.setSecret(name, value, expectedVersion),
        readDetail: () => source.readDetail(name),
        test: () => source.test(name),
        discover: () => Promise.resolve(),
        pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now()
      },
      // The type's host is its own: a changed field never moves the secret elsewhere.
      { config, url: "", key, discovers: false },
      memory.current,
      (step, state) =>
        setSteps((current) =>
          current.map((entry) => (entry.step === step ? { step, state } : entry))
        )
    );
    memory.current = outcome.memory;
    setBusy(false);
    answer(outcome);
  };

  const answer = (outcome: ConnectOutcome) => {
    switch (outcome.status) {
      case "connected":
        onCreated(name);
        return;
      case "held":
        setHeld(true);
        return;
      case "refused":
        setSteps([]);
        if (outcome.reason === "unauthorized") {
          // A refused secret is never shown again: the field is empty and waits for a new one.
          if (secretIndex !== -1) setValues((current) => ({ ...current, [secretIndex]: "" }));
          setErrors({ secret: t("connectionTyped.errorRefused", { service }) });
        } else {
          setErrors({
            general: t(
              outcome.reason === "network_denied"
                ? "connectionTyped.errorEgress"
                : "connectionTyped.errorUnavailable",
              { service }
            )
          });
        }
        return;
      case "secret_failed":
        setSteps([]);
        setErrors({ secret: sentenceOf(outcome.error) });
        return;
      case "write_failed": {
        setSteps([]);
        const { errors: found, detail } = connectionWriteErrors(outcome.error, name, t);
        setErrors({
          ...(found.id === undefined ? {} : { id: found.id }),
          general:
            found.general ??
            Object.values(found).find((sentence) => sentence !== undefined) ??
            t("connectionCreate.errorFailed"),
          ...(detail === undefined ? {} : { detail })
        });
        return;
      }
    }
  };

  const sentenceOf = (error: unknown): string => {
    const outcome = readBuildRefusal(error, t);
    return outcome.ok || outcome.conflict
      ? t("connectionCreate.errorFailed")
      : outcome.refusals.map((refusal) => refusal.message).join(" ");
  };

  // Once written, the Connection is in the list: closing opens its page.
  const close = () => {
    if (busy) return;
    if (created && !held) onCreated(name);
    else onClose();
  };

  const heading = held
    ? t("connectionCreate.heldTitle")
    : t("connectionTyped.heading", { title: offerText(offer.title, locale) });

  return (
    <Dialog
      open
      title={
        created || held ? (
          heading
        ) : (
          <span className="flex min-w-0 items-center gap-1">
            <IconButton
              label={t("connectionCreate.back")}
              size="sm"
              disabled={busy}
              onClick={onBack}
            >
              <ArrowLeft aria-hidden="true" />
            </IconButton>
            <span className="min-w-0">{heading}</span>
          </span>
        )
      }
      onClose={close}
      footer={
        held ? (
          <Button variant="outline" onClick={onClose}>
            {t("connectionCreate.close")}
          </Button>
        ) : (
          <>
            <Button variant="outline" disabled={busy} onClick={close}>
              {t("connectionCreate.cancel")}
            </Button>
            <Button
              loading={busy}
              disabled={!complete}
              data-connection-connect=""
              onClick={() => {
                connect().catch(() => setBusy(false));
              }}
            >
              {t(busy ? "connectionCreate.connecting" : "connectionCreate.connect")}
            </Button>
          </>
        )
      }
    >
      {held ? (
        <Banner layout="line" data-connection-create-held="">
          {t("connectionCreate.held")}
        </Banner>
      ) : (
        <form
          className="grid min-w-0 gap-4"
          data-connection-create-form={offer.type}
          onSubmit={(event) => event.preventDefault()}
        >
          <NameWithAddress
            autoFocus
            value={{ name: title, typedAddress: typedId }}
            onChange={(named) => {
              setTitle(named.name);
              setTypedId(named.typedAddress);
            }}
            derive={(named) => assetAddressFromName(named, CONNECTION_ASSET_KIND)}
            check={errors.id === undefined ? check : { state: "refused", reason: errors.id }}
            nameLabel={t("connectionCreate.name")}
            addressLabel={t("connectionCreate.id")}
            addressHint={t("connectionCreate.idHint")}
            advancedLabel={t("connectionCreate.details")}
            disabled={busy || created}
          >
            <Field
              label={t("connectionPage.descriptionField")}
              hint={t("connectionPage.descriptionHint")}
              optional
            >
              <Textarea
                rows={2}
                value={description}
                disabled={busy}
                data-connection-field="description"
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            {offer.fields.map((field, index) => (
              <Field
                // The fields are the type's, in its order: they never move.
                key={field.setting ?? "secret"}
                label={offerText(field.label, locale)}
                hint={field.help === undefined ? undefined : offerText(field.help, locale)}
                {...(field.optional ? { optional: true } : { required: true })}
                {...(field.secret && errors.secret ? { error: errors.secret } : {})}
              >
                <Input
                  type={field.secret ? "password" : "text"}
                  autoComplete={field.secret ? "new-password" : "off"}
                  spellCheck={false}
                  value={values[index] ?? ""}
                  disabled={busy}
                  data-connection-field={field.setting ?? "secret"}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [index]: event.target.value }))
                  }
                />
              </Field>
            ))}
          </NameWithAddress>
          {steps.length > 0 ? (
            <Steps label={t("connectionCreate.steps")} data-connection-steps="">
              {steps.map(({ step, state }) => (
                <Step
                  key={step}
                  state={state}
                  data-connect-step={step}
                  title={
                    step === "server"
                      ? t("connectionTyped.stepService", { service })
                      : t("connectionCreate.stepKey")
                  }
                />
              ))}
            </Steps>
          ) : null}
          {created ? (
            <Banner layout="line" data-connection-create-saved="">
              {t("connectionTyped.saved", { name: title.trim() })}
            </Banner>
          ) : null}
          {errors.general ? (
            <FormNotice tone="error" data-connection-create-error="">
              {errors.general}
            </FormNotice>
          ) : null}
          <RefusalDetail detail={errors.detail} />
        </form>
      )}
    </Dialog>
  );
}
