import { useState, type ReactNode } from "react";
import { Badge, Field, InlineError, Switch } from "@work-shape/catalyst-ui";
import {
  useOwnChatSkillsQuery,
  useSetOwnChatSkillMutation
} from "../../shared/api/personal-chat-skills";
import { isEmbeddedSession } from "../../shared/embedded-session";
import { useTranslation } from "../../shared/i18n";
import {
  useOptionalSettingsPage,
  type SettingsPageContextValue
} from "../../shared/settings-page-context";
import type { AssetSection } from "./asset-editor-shell";
import type { BuildAssetEditorProps } from "./build-asset-kind";

/** The section with the switch, and the badge the page head shows while it is on. */
export interface SkillMyChatsParts {
  section?: AssetSection;
  badge?: ReactNode;
}

type SkillFrame = {
  asset: Pick<NonNullable<BuildAssetEditorProps["asset"]>, "name"> | undefined;
  owner?: BuildAssetEditorProps["owner"];
};

/**
 * "In meinen Chats verwenden" on a skill of the reader's own Personal Workspace
 * (SCOPE-MYCHATS). The instance decides whose skill it is; on every other skill, and on a page
 * rendered outside the settings page, both parts are absent.
 */
export function SkillMyChats({
  frame,
  children
}: {
  frame: SkillFrame;
  children(parts: SkillMyChatsParts): ReactNode;
}) {
  const settings = useOptionalSettingsPage();
  const name = frame.asset?.name;
  // Only a workspace's skill can be the reader's own: no other asks the instance. An embedding
  // host's session is refused the person's own skills, so it is not asked.
  return settings &&
    !isEmbeddedSession(settings.user) &&
    name !== undefined &&
    frame.owner !== undefined ? (
    <OwnSkillMyChats settings={settings} name={name}>
      {children}
    </OwnSkillMyChats>
  ) : (
    children({})
  );
}

function OwnSkillMyChats({
  settings,
  name,
  children
}: {
  settings: SettingsPageContextValue;
  name: string;
  children(parts: SkillMyChatsParts): ReactNode;
}) {
  const { apiBaseUrl, authScope, client } = settings;
  const { t } = useTranslation();
  const query = useOwnChatSkillsQuery({ apiBaseUrl, authScope, client, enabled: true });
  const setOwn = useSetOwnChatSkillMutation({
    apiBaseUrl,
    authScope,
    client,
    heldMessage: t("skillMyChats.failed")
  });
  const [failed, setFailed] = useState(false);
  const own = query.data?.items.find((item) => item.name === name);
  if (own === undefined) return children({});
  const switchTo = (inMyChats: boolean) => {
    setFailed(false);
    setOwn.mutateAsync({ name, inMyChats }).catch(() => setFailed(true));
  };
  return children({
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
  });
}
