import { defineTranslations } from "./translation-area";

// The shared OAuth sign-in of a Connection (CS-4b4): the step of the New connection dialog,
// the section "Sign-in" of the Connection page, the page a sign-in lands on in its own tab and
// the badge of a Connection's tools while nobody is signed in.
export const connectionSignIn = defineTranslations({
  en: {
    "connectionSignIn.heading": "Sign in to {host}",
    "connectionSignIn.headingPending": "Sign-in",
    "connectionSignIn.starting": "Asking the server how it signs in.",
    "connectionSignIn.shared":
      "Everyone who may use this connection reads and acts through the account you sign in with now.",
    "connectionSignIn.sharedConnected":
      "Everyone who may use this connection reads and acts through this account.",
    "connectionSignIn.scopes": "Permissions it asks for",
    "connectionSignIn.scopesHint": "Unticked permissions are not asked for.",
    "connectionSignIn.scopesFixed": "Which permissions are asked for is set during setup.",
    "connectionSignIn.scopesNone":
      "The provider asks for no single permissions: it grants what its app is set up for.",
    "connectionSignIn.open": "Sign in at {host}",
    "connectionSignIn.waiting": "Waiting for the sign-in in the other tab",
    "connectionSignIn.waitingText":
      "Finish the sign-in at {host}. This window goes on by itself afterwards.",
    "connectionSignIn.cancel": "Cancel",
    "connectionSignIn.tryAgain": "Try again",
    "connectionSignIn.clientHeading": "Register the sign-in app at the provider",
    "connectionSignIn.clientText":
      "This provider registers no apps on its own. Create an app there, enter this address as its redirect URI, and copy its client ID and client secret here.",
    "connectionSignIn.clientTextFixed":
      "This provider registers no apps on its own. The technical team enters the client ID it issued.",
    "connectionSignIn.redirectUri": "Redirect URI",
    "connectionSignIn.redirectUriMissing":
      "No public address is set up yet, so there is no redirect URI. The technical team sets one.",
    "connectionSignIn.clientId": "Client ID",
    "connectionSignIn.appRegistration": "App registration",
    "connectionSignIn.appManaged": "Set up by the technical team",
    "connectionSignIn.clientSecret": "Client secret",
    "connectionSignIn.clientSecretHint":
      "Stored encrypted. Nobody can read it back. Leave empty if the provider issued none.",
    "connectionSignIn.clientSave": "Save and continue",
    "connectionSignIn.redirectUriHint":
      "Enter this address at the provider as the redirect URI of the app, if it is not there yet.",
    "connectionSignIn.signedIn": "Signed in",
    "connectionSignIn.readTools": "Read tools",
    "connectionSignIn.errorDenied": "The sign-in was declined or cancelled at {host}.",
    "connectionSignIn.errorDeniedUnnamed": "The sign-in was declined or cancelled at the provider.",
    "connectionSignIn.errorExpired": "The sign-in took too long. Start it again.",
    "connectionSignIn.errorEgress":
      "Access to {host} is not allowed. The technical team has to allow this host first.",
    "connectionSignIn.errorEgressUnnamed":
      "Access to the provider's server is not allowed. The technical team has to allow its host first.",
    "connectionSignIn.errorPkce":
      "{host} does not offer PKCE with S256, so this connection cannot be signed in safely.",
    "connectionSignIn.errorPkceUnnamed":
      "The provider does not offer PKCE with S256, so this connection cannot be signed in safely.",
    "connectionSignIn.errorRedirect":
      "No public address is set up, so the provider has nowhere to send you back. The technical team sets one.",
    "connectionSignIn.errorDiscovery": "The server's sign-in details could not be read.",
    "connectionSignIn.errorRegistration": "The provider refused to register the sign-in app.",
    "connectionSignIn.errorIssuer": "The sign-in server answered for another issuer.",
    "connectionSignIn.errorState": "This sign-in is unknown or was started by someone else.",
    "connectionSignIn.errorChanged":
      "The connection was changed while the sign-in was under way. Start it again.",
    "connectionSignIn.errorPerson": "Only a person signed in here can sign in at the provider.",
    "connectionSignIn.errorClient": "The provider needs a client ID first.",
    "connectionSignIn.errorForbidden": "You may not sign in this connection.",
    "connectionSignIn.errorTab":
      "The browser opened no new tab. Allow pop-ups for this page and try again.",
    "connectionSignIn.errorFailed": "The sign-in did not work.",
    "connectionSignIn.errorAdminConsent":
      "Your organisation lets only its IT approve apps. Send them the link below: they open it once and accept. Then try again.",
    "connectionSignIn.adminConsentTitle": "Your IT has to approve this app once",
    "connectionSignIn.adminConsentLink": "Approval link for IT",
    "connectionSignIn.adminConsentHint":
      "Only needed where an organisation lets only its IT approve apps. An administrator opens it once and accepts; then everyone there connects on their own.",
    "connectionSignIn.landingApprovedTitle": "Approved",
    "connectionSignIn.landingApproved":
      "People in your organisation can connect now. You can close this tab.",
    "connectionSignIn.sectionTitle": "Sign-in",
    "connectionSignIn.sectionDescription":
      "The account at the provider that every call of this connection uses.",
    "connectionSignIn.state": "State",
    "connectionSignIn.stateConnected": "Connected",
    "connectionSignIn.stateNeedsReconnect": "Sign in again",
    "connectionSignIn.stateRevoked": "Disconnected",
    "connectionSignIn.stateNone": "Not signed in",
    "connectionSignIn.provider": "Provider",
    "connectionSignIn.account": "Account",
    "connectionSignIn.accountUnnamed": "The provider names no account.",
    "connectionSignIn.connected": "Connected",
    "connectionSignIn.connectedBy": "since {time}, by {name}",
    "connectionSignIn.connectedSince": "since {time}",
    "connectionSignIn.scopesGranted": "Permissions",
    "connectionSignIn.scopesGrantedNone": "None named",
    "connectionSignIn.start": "Sign in",
    "connectionSignIn.restart": "Sign in again",
    "connectionSignIn.memberText": "An administrator signs this connection in.",
    "connectionSignIn.landingConnected": "Connected. You can close this tab.",
    "connectionSignIn.landingFailedTitle": "The sign-in did not work",
    "connectionSignIn.landingOpen": "Open the connection",
    "connectionSignIn.landingList": "Open connections",
    "connectionSignIn.needed": "Sign-in needed"
  },
  de: {
    "connectionSignIn.heading": "Anmeldung bei {host}",
    "connectionSignIn.headingPending": "Anmeldung",
    "connectionSignIn.starting": "Der Server wird gefragt, wie er anmeldet.",
    "connectionSignIn.shared":
      "Alle, die diese Verbindung nutzen dürfen, lesen und handeln über das Konto, mit dem du dich jetzt anmeldest.",
    "connectionSignIn.sharedConnected":
      "Alle, die diese Verbindung nutzen dürfen, lesen und handeln über dieses Konto.",
    "connectionSignIn.scopes": "Berechtigungen, nach denen gefragt wird",
    "connectionSignIn.scopesHint": "Nach abgewählten Berechtigungen wird nicht gefragt.",
    "connectionSignIn.scopesFixed":
      "Nach welchen Berechtigungen gefragt wird, ist bei der Einrichtung festgelegt.",
    "connectionSignIn.scopesNone":
      "Der Anbieter fragt nach keinen einzelnen Berechtigungen: Er gewährt, wofür seine App eingerichtet ist.",
    "connectionSignIn.open": "Bei {host} anmelden",
    "connectionSignIn.waiting": "Warte auf die Anmeldung im anderen Tab",
    "connectionSignIn.waitingText":
      "Schließ die Anmeldung bei {host} ab. Danach geht es hier von selbst weiter.",
    "connectionSignIn.cancel": "Abbrechen",
    "connectionSignIn.tryAgain": "Erneut versuchen",
    "connectionSignIn.clientHeading": "Anmelde-App beim Anbieter registrieren",
    "connectionSignIn.clientText":
      "Dieser Anbieter registriert Apps nicht von selbst. Leg dort eine App an, trag diese Adresse als Redirect-URI ein und kopier Client-ID und Client-Secret hierher.",
    "connectionSignIn.clientTextFixed":
      "Dieser Anbieter registriert Apps nicht von selbst. Das technische Team trägt die Client-ID ein, die er ausgegeben hat.",
    "connectionSignIn.redirectUri": "Redirect-URI",
    "connectionSignIn.redirectUriMissing":
      "Es ist noch keine öffentliche Adresse eingerichtet und damit keine Redirect-URI. Das technische Team legt eine fest.",
    "connectionSignIn.clientId": "Client-ID",
    "connectionSignIn.appRegistration": "App-Registrierung",
    "connectionSignIn.appManaged": "Eingerichtet vom technischen Team",
    "connectionSignIn.clientSecret": "Client-Secret",
    "connectionSignIn.clientSecretHint":
      "Verschlüsselt gespeichert. Niemand kann es wieder lesen. Leer lassen, wenn der Anbieter keins ausgegeben hat.",
    "connectionSignIn.clientSave": "Speichern und weiter",
    "connectionSignIn.redirectUriHint":
      "Trage diese Adresse beim Anbieter als Redirect-URI der App ein, falls sie dort noch fehlt.",
    "connectionSignIn.signedIn": "Angemeldet",
    "connectionSignIn.readTools": "Tools lesen",
    "connectionSignIn.errorDenied": "Die Anmeldung wurde bei {host} abgelehnt oder abgebrochen.",
    "connectionSignIn.errorDeniedUnnamed":
      "Die Anmeldung wurde beim Anbieter abgelehnt oder abgebrochen.",
    "connectionSignIn.errorExpired": "Die Anmeldung hat zu lange gedauert. Starte sie neu.",
    "connectionSignIn.errorEgress":
      "Der Zugriff auf {host} ist nicht erlaubt. Das technische Team muss diesen Host erst freigeben.",
    "connectionSignIn.errorEgressUnnamed":
      "Der Zugriff auf den Server des Anbieters ist nicht erlaubt. Das technische Team muss seinen Host erst freigeben.",
    "connectionSignIn.errorPkce":
      "{host} bietet kein PKCE mit S256 an. So lässt sich diese Verbindung nicht sicher anmelden.",
    "connectionSignIn.errorPkceUnnamed":
      "Der Anbieter bietet kein PKCE mit S256 an. So lässt sich diese Verbindung nicht sicher anmelden.",
    "connectionSignIn.errorRedirect":
      "Es ist keine öffentliche Adresse eingerichtet, also kann der Anbieter dich nicht zurückschicken. Das technische Team legt eine fest.",
    "connectionSignIn.errorDiscovery": "Die Anmeldedaten des Servers ließen sich nicht lesen.",
    "connectionSignIn.errorRegistration":
      "Der Anbieter hat die Registrierung der Anmelde-App abgelehnt.",
    "connectionSignIn.errorIssuer":
      "Der Anmeldeserver hat für einen anderen Aussteller geantwortet.",
    "connectionSignIn.errorState":
      "Diese Anmeldung ist unbekannt oder wurde von jemand anderem gestartet.",
    "connectionSignIn.errorChanged":
      "Die Verbindung wurde während der Anmeldung geändert. Starte sie neu.",
    "connectionSignIn.errorPerson":
      "Nur eine Person, die hier angemeldet ist, kann sich beim Anbieter anmelden.",
    "connectionSignIn.errorClient": "Der Anbieter braucht zuerst eine Client-ID.",
    "connectionSignIn.errorForbidden": "Du darfst diese Verbindung nicht anmelden.",
    "connectionSignIn.errorTab":
      "Der Browser hat keinen neuen Tab geöffnet. Erlaube Pop-ups für diese Seite und versuch es noch einmal.",
    "connectionSignIn.errorFailed": "Die Anmeldung hat nicht geklappt.",
    "connectionSignIn.errorAdminConsent":
      "In deiner Organisation gibt nur die IT Apps frei. Schick ihr den Link unten: Sie öffnet ihn einmal und stimmt zu. Dann versuch es noch einmal.",
    "connectionSignIn.adminConsentTitle": "Deine IT muss diese App einmal freigeben",
    "connectionSignIn.adminConsentLink": "Freigabe-Link für die IT",
    "connectionSignIn.adminConsentHint":
      "Nur nötig, wo eine Organisation Apps allein von ihrer IT freigeben lässt. Eine Administratorin oder ein Administrator öffnet ihn einmal und stimmt zu; danach verbinden sich dort alle selbst.",
    "connectionSignIn.landingApprovedTitle": "Freigegeben",
    "connectionSignIn.landingApproved":
      "Personen in deiner Organisation können sich jetzt verbinden. Du kannst diesen Tab schließen.",
    "connectionSignIn.sectionTitle": "Anmeldung",
    "connectionSignIn.sectionDescription":
      "Das Konto beim Anbieter, das jeder Aufruf dieser Verbindung nutzt.",
    "connectionSignIn.state": "Zustand",
    "connectionSignIn.stateConnected": "Verbunden",
    "connectionSignIn.stateNeedsReconnect": "Neu anmelden nötig",
    "connectionSignIn.stateRevoked": "Getrennt",
    "connectionSignIn.stateNone": "Nicht angemeldet",
    "connectionSignIn.provider": "Anbieter",
    "connectionSignIn.account": "Konto",
    "connectionSignIn.accountUnnamed": "Der Anbieter nennt kein Konto.",
    "connectionSignIn.connected": "Verbunden",
    "connectionSignIn.connectedBy": "seit {time}, von {name}",
    "connectionSignIn.connectedSince": "seit {time}",
    "connectionSignIn.scopesGranted": "Berechtigungen",
    "connectionSignIn.scopesGrantedNone": "Keine genannt",
    "connectionSignIn.start": "Anmelden",
    "connectionSignIn.restart": "Neu anmelden",
    "connectionSignIn.memberText":
      "Eine Administratorin oder ein Administrator meldet diese Verbindung an.",
    "connectionSignIn.landingConnected": "Verbunden. Du kannst diesen Tab schließen.",
    "connectionSignIn.landingFailedTitle": "Die Anmeldung hat nicht geklappt",
    "connectionSignIn.landingOpen": "Zur Verbindung",
    "connectionSignIn.landingList": "Zu den Verbindungen",
    "connectionSignIn.needed": "Anmeldung nötig"
  }
});
