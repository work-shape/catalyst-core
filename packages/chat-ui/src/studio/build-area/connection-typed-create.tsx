import { ArrowLeft } from "lucide-react";
import { Fragment, useRef, useState, type ReactNode } from "react";
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
import type { CataloguePartName } from "./connection-catalogue-model";
import type { ConnectionCredentialMode } from "./connection-form-model";
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

/** A Connection installed from a catalogue entry's part (CAT-1). */
export interface TypedInstall {
  /** The link the definition keeps to the entry. It grants nothing. */
  link: { entry: string; part: CataloguePartName; version: number };
  /** Above the fields: what the part does, example prompts, the checklist. */
  intro?: ReactNode;
  /** Before the secret field: whose account it is and who reads what it reads. */
  note: ReactNode;
  /** Whose account the Connection reads with. Left out, shared. */
  credentialMode?: ConnectionCredentialMode;
  /**
   * The part signs in after the connect (OAuth): Verbinden saves and sets the client secret,
   * and runs no test, which cannot pass before the sign-in.
   */
  signsIn?: boolean;
  /**
   * The id is the part's fixed name: the redirect URI registered at the provider names it,
   * so it shows and cannot be changed.
   */
  addressFixed?: boolean;
  /**
   * The revision of the delete where a deleted Connection had the fixed address: the first
   * write names it and installs the Connection anew. The address then counts as free.
   */
  recreates?: number;
}

/** What a connected Connection is, for a flow that goes on after the connect. */
export interface TypedConnected {
  name: string;
  title: string;
  config: Record<string, unknown>;
  revision: number;
}

export function TypedConnectionCreate({
  offer,
  source,
  checkName,
  put,
  onBack,
  onClose,
  onCreated,
  initial,
  install,
  defaults,
  onConnected
}: Pick<BuildCreateDialogProps, "checkName" | "put" | "onClose" | "onCreated"> & {
  offer: ConnectorTypeOffer;
  source: ConnectionSource;
  onBack(): void;
  /** The name and id an agent proposed (CHAT-CONN-1): the form starts with them. */
  initial?: { title: string; name: string };
  /** The catalogue entry's part this form installs, where it does. */
  install?: TypedInstall;
  /** What the fields start with, by position. Never a secret. */
  defaults?: TypedValues;
  /** Where the flow goes on once connected; without it the Connection's page opens. */
  onConnected?(connected: TypedConnected): void;
}) {
  const { locale, t } = useTranslation();
  // The service in words: the form's title. Its `service` is a slug for the mark only.
  const service = offerText(offer.title, locale);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [typedId, setTypedId] = useState<string | undefined>(() =>
    install?.addressFixed && initial !== undefined
      ? initial.name
      : initial === undefined ||
          initial.name === assetAddressFromName(initial.title, CONNECTION_ASSET_KIND)
        ? undefined
        : initial.name
  );
  const [description, setDescription] = useState("");
  const [values, setValues] = useState<TypedValues>(() => ({ ...defaults }));
  const [errors, setErrors] = useState<Errors>({});
  const [steps, setSteps] = useState<{ step: ConnectStep; state: ConnectStepState }[]>([]);
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState(false);
  const memory = useRef<ConnectMemory>({});

  const name = (typedId ?? assetAddressFromName(title, CONNECTION_ASSET_KIND)).trim();
  const created = memory.current.revision !== undefined;
  // The address a deleted Connection had reads as taken; the install writes over its delete.
  const check = useAddressCheck(
    created || install?.recreates !== undefined ? undefined : checkName,
    name
  );
  const complete =
    title.trim() !== "" &&
    name !== "" &&
    typedComplete(offer, values) &&
    !addressBlocksCreate(check);
  const secretIndex = offer.fields.findIndex((field) => field.secret);

  const connect = async () => {
    const key = typedSecret(offer, values);
    const config = {
      ...typedConnectionConfig(offer, { name, title: title.trim(), description }, values),
      ...(install === undefined ? {} : { catalogue: install.link }),
      ...(install?.credentialMode === "user" ? { credentialMode: "user" as const } : {})
    };
    setBusy(true);
    setErrors({});
    const order: ConnectStep[] = ["server", ...(key === "" ? [] : (["key"] as const))];
    setSteps(order.map((step) => ({ step, state: step === "server" ? "running" : "queued" })));
    const outcome = await connectConnection(
      {
        put: async (definition, expectedRevision) =>
          (
            await put({
              name,
              config: definition,
              expectedRevision: expectedRevision ?? install?.recreates ?? null
            })
          ).revision,
        setSecret: (value, expectedVersion, expectedRevision) =>
          source.setSecret(name, value, expectedVersion, expectedRevision),
        readDetail: () => source.readDetail(name),
        test: () => source.test(name),
        discover: () => Promise.resolve(),
        pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now()
      },
      // The type's host is its own: a changed field never moves the secret elsewhere.
      { config, url: "", key, discovers: false, tests: install?.signsIn !== true },
      memory.current,
      (step, state) =>
        setSteps((current) =>
          current.map((entry) => (entry.step === step ? { step, state } : entry))
        )
    );
    memory.current = outcome.memory;
    setBusy(false);
    answer(outcome, config);
  };

  const answer = (outcome: ConnectOutcome, config: Record<string, unknown>) => {
    switch (outcome.status) {
      case "connected": {
        const revision = outcome.memory.revision;
        if (onConnected && revision !== undefined) {
          onConnected({ name, title: title.trim(), config, revision });
          return;
        }
        onCreated(name);
        return;
      }
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
        const { errors: found, detail } = connectionWriteErrors(outcome.error, name, t, locale);
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
    const outcome = readBuildRefusal(error, t, locale);
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
          {install?.intro}
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
            addressFixed={install?.addressFixed === true}
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
              // The fields are the type's, in its order: they never move.
              <Fragment key={field.setting ?? "secret"}>
                {field.secret && install ? install.note : null}
                <Field
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
              </Fragment>
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
