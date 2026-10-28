import { useState, type ReactNode } from "react";
import { Badge, Field, InlineError, Switch } from "@work-shape/catalyst-ui";
import {
  useOwnChatSkillsQuery,
  useSetOwnChatSkillMutation
} from "../../shared/api/personal-chat-skills";
import { useTranslation } from "../../shared/i18n";
import { useSettingsPage } from "../../shared/settings-page-context";
import type { AssetSection } from "./asset-editor-shell";
import type { BuildAssetEditorProps } from "./build-asset-kind";

/**
 * "In meinen Chats verwenden" on a skill of the reader's own Personal Workspace
 * (SCOPE-MYCHATS): the section with the switch, and the badge the page head shows while it is
 * on. The instance decides whose skill it is; on every other skill both are absent.
 */
export function useSkillMyChats(frame: Pick<BuildAssetEditorProps, "asset" | "owner">): {
  section?: AssetSection;
  badge?: ReactNode;
} {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const name = frame.asset?.name;
  // Only a workspace's skill can be the reader's own: no other asks the instance.
  const query = useOwnChatSkillsQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: name !== undefined && frame.owner !== undefined
  });
  const setOwn = useSetOwnChatSkillMutation({
    apiBaseUrl,
    authScope,
    client,
    heldMessage: t("skillMyChats.failed")
  });
  const [failed, setFailed] = useState(false);
  const own = query.data?.items.find((item) => item.name === name);
  if (name === undefined || own === undefined) return {};
  const switchTo = (inMyChats: boolean) => {
    setFailed(false);
    setOwn.mutateAsync({ name, inMyChats }).catch(() => setFailed(true));
  };
  return {
    badge: own.inMyChats ? (
      <Badge data-skill-my-chats="on">{t("skillMyChats.on")}</Badge>
    ) : undefined,
    section: {
      id: "my-chats",
      label: t("skillMyChats.section"),
      description: t("skillMyChats.sectionDescription"),
      body: (
        <div className="grid gap-3" data-skill-my-chats-section="">
          <Field
            layout="inline"
            label={t("skillMyChats.switch")}
            hint={t("skillMyChats.switchHint")}
          >
            <Switch
              checked={own.inMyChats}
              disabled={setOwn.isPending}
              onCheckedChange={switchTo}
            />
          </Field>
          {failed ? <InlineError>{t("skillMyChats.failed")}</InlineError> : null}
        </div>
      )
    }
  };
}
