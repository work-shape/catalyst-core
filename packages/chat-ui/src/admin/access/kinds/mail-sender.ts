import type { GrantKindEntry } from "./entry";

// `mail_sender.use` is granted on one sender, `system`, while outbound mail is on. It is no
// asset kind the dialog lists; a row given through the API is shown and revoked here.
export const mailSenderKind: GrantKindEntry<"mail_sender"> = {
  label: "access.kindMailSender",
  words: {
    scopeAsset: "access.scopeMailSender",
    object: "access.objectMailSender",
    onAsset: "access.scopeOnMailSender",
    onAssetDescription: "access.scopeOnMailSenderDescription",
    assetField: "access.grantMailSender",
    chooseAsset: "access.chooseMailSender",
    noAssets: "access.noMailSenders",
    assetsLoadFailed: "access.mailSendersLoadFailed"
  }
};
