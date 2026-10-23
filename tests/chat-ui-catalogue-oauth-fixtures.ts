import type { CatalogueEntryOffer } from "@work-shape/catalyst-chat-ui/build-area";

// A catalogue entry with an OAuth tools part (CAT-OAUTH-UI), for the tests of its install.

export const REDIRECT = "https://chat.example.test/api/v1/connections/mailbox/oauth/callback";

/** A mail entry with an identity group, a recommended reading group and two further ones. */
export const mailbox: CatalogueEntryOffer = {
  id: "mailbox",
  version: 2,
  service: "mailbox",
  title: { en: "Mailbox", de: "Postfach" },
  description: { en: "Read your mail.", de: "Deine Post lesen." },
  category: "mail",
  examplePrompts: [{ en: "What came in today?", de: "Was kam heute rein?" }],
  mark: { color: "#7a3b2e" },
  offered: true,
  parts: [
    {
      part: "tools",
      connectorType: "http_api",
      name: "mailbox",
      description: { en: "Agents read mail.", de: "Agenten lesen Post." },
      authScheme: "oauth",
      credentialModes: ["user", "shared"],
      defaultCredentialMode: "user",
      groups: [
        { id: "identity", title: { en: "Identity", de: "Identität" }, scopes: ["openid", "email"] },
        { id: "read", title: { en: "Read", de: "Lesen" }, scopes: ["mail.read"] },
        { id: "organise", title: { en: "Organise", de: "Ordnen" }, scopes: ["mail.modify"] },
        { id: "send", title: { en: "Send", de: "Senden" }, scopes: ["mail.send"] }
      ],
      settings: {
        baseUrl: "https://mail.example.test/v1",
        oauth: {
          authorizationUrl: "https://login.example.test/authorize",
          tokenUrl: "https://login.example.test/token",
          scopes: ["openid", "email"]
        }
      },
      fields: [
        {
          label: { en: "Client ID", de: "Client-ID" },
          optional: false,
          setting: "oauth.clientId",
          secret: false
        },
        { label: { en: "Client secret", de: "Client-Secret" }, optional: false, secret: true }
      ],
      prerequisites: [{ text: { en: "Create a web client.", de: "Leg einen Web-Client an." } }],
      hosts: ["mail.example.test", "login.example.test"],
      redirectUri: REDIRECT,
      sharedAccountNote: {
        en: "Everyone reads the one shared mailbox.",
        de: "Alle lesen das eine gemeinsame Postfach."
      },
      documentSource: false,
      operations: [
        {
          name: "searchMessages",
          group: "read",
          effect: "reading",
          recommended: true,
          declaration: { method: "GET", path: "/messages" }
        },
        {
          name: "getMessage",
          group: "read",
          effect: "reading",
          recommended: true,
          declaration: { method: "GET", path: "/messages/{id}" }
        },
        {
          name: "listLabels",
          group: "organise",
          effect: "reading",
          recommended: false,
          declaration: { method: "GET", path: "/labels" }
        },
        {
          name: "sendMessage",
          group: "send",
          effect: "changing",
          recommended: true,
          declaration: { method: "POST", path: "/send" }
        }
      ]
    }
  ]
};
