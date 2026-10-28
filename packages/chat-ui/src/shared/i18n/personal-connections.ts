import { defineTranslations } from "./translation-area";

// Personal connections (CS-9a-UI): You > Connections, the People section and the sign-in of a
// personal Connection's page, the choice of whose account in the New connection dialog, and the
// Personal chip on an agent's tools.
export const personalConnections = defineTranslations({
  en: {
    "settings.personalConnections": "Connections",
    "personalConnections.description":
      "Your own accounts at other services. Agents use them only in your private chats.",
    "personalConnections.empty":
      "No connection asks for your own account yet. An administrator sets them up.",
    "personalConnections.loadFailed": "Your connections could not be loaded.",
    "personalConnections.yourAccounts": "Your accounts",
    "personalConnections.stateConnected": "Connected as {account}",
    "personalConnections.stateConnectedUnnamed": "Connected",
    "personalConnections.stateNotConnected": "Not connected",
    "personalConnections.stateNeedsReconnect": "Sign in again",
    "personalConnections.since": "since {time}",
    "personalConnections.lastUsed": "last used {day}",
    "personalConnections.connect": "Connect",
    "personalConnections.reconnect": "Sign in again",
    "personalConnections.disconnect": "Disconnect",
    "personalConnections.disconnectTitle": "Disconnect {title}?",
    "personalConnections.disconnectText":
      "Agents can no longer use your account at {title}. The stored access is deleted and the provider is asked to withdraw it.",
    "personalConnections.disconnectFailed": "Disconnecting did not work.",
    "personalConnections.providerKept":
      "Disconnected. The provider did not confirm that it withdrew the access: remove it in your account there.",
    "personalConnections.signInText":
      "You sign in with your own account. Only you read and act through it, in your private chats.",
    "personalConnections.sectionDescription":
      "Your own account at the provider. Each person connects their own, and nobody else uses yours.",
    "personalConnections.mayNotConnect": "You may not use this connection, so you cannot connect.",
    "personalConnections.peopleTitle": "People",
    "personalConnections.peopleDescription": "Who connected their own account to this connection.",
    "personalConnections.peopleEmpty": "Nobody has connected an account yet.",
    "personalConnections.peopleFailed": "The people could not be loaded.",
    "personalConnections.unknownPerson": "Unknown person",
    "personalConnections.accountUnnamed": "No account named",
    "personalConnections.providerGrantStays":
      "Revoking deletes the access stored here. The grant at the provider stays until the person removes it there or it expires.",
    "personalConnections.revoke": "Revoke",
    "personalConnections.revokeTitle": "Revoke the sign-in of {name}?",
    "personalConnections.revokeText":
      "Agents can no longer use this account. The grant at the provider stays until {name} removes it there or it expires.",
    "personalConnections.revokeFailed": "Revoking did not work.",
    "personalConnections.whoseAccount": "Whose account",
    "personalConnections.modeShared": "Shared",
    "personalConnections.modeSharedText": "One account for everyone who may use the connection.",
    "personalConnections.modePersonal": "Personal",
    "personalConnections.modePersonalText":
      "Each person connects their own account. Its tools work only in their private chats.",
    "personalConnections.modeLocked":
      "Set when the connection was made. For the other choice, make a new connection.",
    "personalConnections.chip": "Personal",
    "personalConnections.chipTooltip":
      "Each person uses their own account. These tools work only in their private chats."
  },
  de: {
    "settings.personalConnections": "Verbindungen",
    "personalConnections.description":
      "Deine eigenen Konten bei anderen Diensten. Agents nutzen sie nur in deinen privaten Chats.",
    "personalConnections.empty":
      "Noch keine Verbindung fragt nach deinem eigenen Konto. Eine Administratorin oder ein Administrator richtet sie ein.",
    "personalConnections.loadFailed": "Deine Verbindungen ließen sich nicht laden.",
    "personalConnections.yourAccounts": "Deine Konten",
    "personalConnections.stateConnected": "Verbunden als {account}",
    "personalConnections.stateConnectedUnnamed": "Verbunden",
    "personalConnections.stateNotConnected": "Nicht verbunden",
    "personalConnections.stateNeedsReconnect": "Neu anmelden nötig",
    "personalConnections.since": "seit {time}",
    "personalConnections.lastUsed": "zuletzt genutzt am {day}",
    "personalConnections.connect": "Verbinden",
    "personalConnections.reconnect": "Neu anmelden",
    "personalConnections.disconnect": "Trennen",
    "personalConnections.disconnectTitle": "{title} trennen?",
    "personalConnections.disconnectText":
      "Agents können dein Konto bei {title} dann nicht mehr nutzen. Der gespeicherte Zugang wird gelöscht und der Anbieter gebeten, ihn zu widerrufen.",
    "personalConnections.disconnectFailed": "Das Trennen hat nicht geklappt.",
    "personalConnections.providerKept":
      "Getrennt. Der Anbieter hat nicht bestätigt, dass er den Zugang widerrufen hat: Entferne ihn dort in deinem Konto.",
    "personalConnections.signInText":
      "Du meldest dich mit deinem eigenen Konto an. Nur du liest und handelst darüber, in deinen privaten Chats.",
    "personalConnections.sectionDescription":
      "Dein eigenes Konto beim Anbieter. Jede Person verbindet ihr eigenes, und niemand sonst nutzt deins.",
    "personalConnections.mayNotConnect":
      "Du darfst diese Verbindung nicht nutzen und kannst dich deshalb nicht verbinden.",
    "personalConnections.peopleTitle": "Personen",
    "personalConnections.peopleDescription":
      "Wer sein eigenes Konto mit dieser Verbindung verbunden hat.",
    "personalConnections.peopleEmpty": "Noch niemand hat ein Konto verbunden.",
    "personalConnections.peopleFailed": "Die Personen ließen sich nicht laden.",
    "personalConnections.unknownPerson": "Unbekannte Person",
    "personalConnections.accountUnnamed": "Kein Konto genannt",
    "personalConnections.providerGrantStays":
      "Widerrufen löscht den hier gespeicherten Zugang. Die Freigabe beim Anbieter bleibt, bis die Person sie dort entfernt oder sie abläuft.",
    "personalConnections.revoke": "Widerrufen",
    "personalConnections.revokeTitle": "Anmeldung von {name} widerrufen?",
    "personalConnections.revokeText":
      "Agents können dieses Konto dann nicht mehr nutzen. Die Freigabe beim Anbieter bleibt, bis {name} sie dort entfernt oder sie abläuft.",
    "personalConnections.revokeFailed": "Das Widerrufen hat nicht geklappt.",
    "personalConnections.whoseAccount": "Wessen Konto",
    "personalConnections.modeShared": "Geteilt",
    "personalConnections.modeSharedText": "Ein Konto für alle, die die Verbindung nutzen dürfen.",
    "personalConnections.modePersonal": "Persönlich",
    "personalConnections.modePersonalText":
      "Jede Person verbindet ihr eigenes Konto. Die Tools funktionieren nur in ihren privaten Chats.",
    "personalConnections.modeLocked":
      "Bei der Anlage festgelegt. Für die andere Wahl leg eine neue Verbindung an.",
    "personalConnections.chip": "Persönlich",
    "personalConnections.chipTooltip":
      "Jede Person nutzt ihr eigenes Konto. Diese Tools funktionieren nur in ihren privaten Chats."
  }
});
