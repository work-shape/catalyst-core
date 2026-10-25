import {
  Banner,
  Button,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { BuildAssetEditorProps } from "./build-asset-kind";
import type { CatalogueUpdate } from "./connection-catalogue-update-model";
import { useConnectionWrite } from "./connection-editing";
import { offerText } from "./connection-typed-model";
import { RefusalNotice } from "./refusal-notice";

// The offer to relink a Connection on the operator's managed OAuth client to the version of its
// catalogue entry this instance ships (MS-APP-RELINK). The update writes the current version's
// settings through the frame's save, as any change of the page does: the instance holds the
// Connection to exactly those settings, and keeps its sign-ins where its addresses stay.

export function ConnectionCatalogueUpdate({
  update,
  frame,
  written
}: {
  update: CatalogueUpdate;
  frame: BuildAssetEditorProps;
  written(): void;
}) {
  const { locale, t } = useTranslation();
  const write = useConnectionWrite(frame, written);
  const to = update.entry.version;
  return (
    <Banner
      tone="warning"
      data-connection-catalogue-update=""
      title={t("connectionCatalogue.updateTitle", {
        title: offerText(update.entry.title, locale)
      })}
      action={
        <Button
          size="sm"
          loading={write.saving === "catalogue-update"}
          disabled={frame.saveBlocked}
          data-connection-catalogue-update-apply=""
          onClick={() => {
            write.write("catalogue-update", update.config).catch(() => undefined);
          }}
        >
          {t("connectionCatalogue.updateApply", { version: to })}
        </Button>
      }
    >
      <div className="grid gap-2">
        <p>{t("connectionCatalogue.updateText", { from: update.from, to })}</p>
        <p>{t("connectionCatalogue.updateKeeps", { to })}</p>
        {update.changed.length === 0 ? null : (
          <Disclosure data-connection-catalogue-update-changes="">
            <DisclosureTrigger>{t("connectionCatalogue.updateChanges")}</DisclosureTrigger>
            <DisclosureContent>
              <ul className="grid gap-0.5">
                {update.changed.map((path) => (
                  <li key={path}>
                    <code className="font-mono text-code break-all">{path}</code>
                  </li>
                ))}
              </ul>
            </DisclosureContent>
          </Disclosure>
        )}
        {write.failure ? <RefusalNotice {...write.failure} /> : null}
      </div>
    </Banner>
  );
}
