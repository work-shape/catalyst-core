import { defineTranslations } from "./translation-area";

// A person's own MCP server (PMCP-5): the section, its cards, the add dialog and the tools
// dialog on You > Connections.
export const ownServers = defineTranslations({
  en: {
    "ownServers.title": "Your MCP servers",
    "ownServers.description":
      "MCP servers you added yourself. Only you use them, in your private chats.",
    "ownServers.add": "Add MCP server",
    "ownServers.empty": "You have not added an MCP server yet.",
    "ownServers.addressLabel": "Address",
    "ownServers.addressHint": "The address of the server, such as https://example.com/mcp.",
    "ownServers.addressPlaceholder": "https://example.com/mcp",
    "ownServers.connect": "Connect",
    "ownServers.checking": "Contacting {host}…",
    "ownServers.addressEmpty": "Enter the server's address.",
    "ownServers.addressInvalid": "This is not a web address like https://example.com/mcp.",
    "ownServers.addressCredentials":
      "Leave the name and password out of the address: you sign in in the next step.",
    "ownServers.addressQuery": "Leave out everything from ? or # on.",
    "ownServers.unreachable": "{host} did not answer as an MCP server. Check the address.",
    "ownServers.egress":
      "Your own MCP servers may not reach {host} here. Use a public https address, or ask an administrator.",
    "ownServers.noSignIn":
      "{host} asks for no sign-in. A server without a sign-in cannot be added yet.",
    "ownServers.limit":
      "You have added {limit} MCP servers, the most allowed here. Remove one first.",
    "ownServers.off": "Adding your own MCP servers is switched off here.",
    "ownServers.failed": "Adding the server did not work. Try again.",
    "ownServers.reading": "Reading the tools…",
    "ownServers.nameLabel": "Name",
    "ownServers.nameHint": "What you and your agents call this server.",
    "ownServers.toolsText":
      "Choose what your agents may use in your private chats. A tool that changes something asks you before each call.",
    "ownServers.noTools": "The server names no tools.",
    "ownServers.toolsLate":
      "The tools have not come in yet. Choose them later with Change tools on the server's card.",
    "ownServers.done": "Done",
    "ownServers.stateOff": "Switched off",
    "ownServers.offText": "Switched off. Your agents do not use it.",
    "ownServers.toolCount": "{count} tools",
    "ownServers.toolCountOne": "1 tool",
    "ownServers.changeTools": "Change tools",
    "ownServers.remove": "Remove",
    "ownServers.removeTitle": "Remove {title}?",
    "ownServers.removeText":
      "Your agents can no longer use this server. Your sign-in there ends and the server is deleted here.",
    "ownServers.removeFailed": "Removing did not work.",
    "ownServers.toolsTitle": "Tools of {title}",
    "ownServers.askAgain": "Ask again",
    "ownServers.readAgain": "Read tools again",
    "ownServers.save": "Save",
    "ownServers.saveFailed": "Saving did not work.",
    "ownServers.proposalLabel": "Add MCP server",
    "ownServers.proposalOpen": "Open",
    "ownServers.proposalNote":
      "You connect, sign in and choose its tools there. Nothing is saved before.",
    "ownServers.proposalReader": "Only the person whose chat this is adds their own MCP server.",
    "ownServers.toldTools": "I added my MCP server {title}. {count} tools accepted: {tools}.",
    "ownServers.toldOne": "I added my MCP server {title}. 1 tool accepted: {tools}.",
    "ownServers.toldNoTools": "I added my MCP server {title}, with no tools accepted yet.",
    "ownServers.toldName": "“{name}”",
    "ownServers.toldMore": "+ {count} more",
    "ownServers.loadFailed": "The tools could not be loaded.",
    "ownServers.tokenTitle": "Token for {host}",
    "ownServers.tokenText": "{host} takes a token from you. Paste the one the service gave you.",
    "ownServers.tokenLabel": "Token",
    "ownServers.tokenHint": "It is stored encrypted, sent only to {host} and never shown again.",
    "ownServers.tokenEmpty": "Paste the token.",
    "ownServers.tokenDetails": "Technical details",
    "ownServers.headerLabel": "Header",
    "ownServers.headerHint":
      "Empty or Authorization: the token goes the usual way. Otherwise the header the service names for it.",
    "ownServers.headerInvalid": "A header name has letters, digits and hyphens, a letter first.",
    "ownServers.tokenRefused": "{host} refused the token. Check it and paste it again.",
    "ownServers.tokenFailed": "The token could not be saved.",
    "ownServers.useToken": "Paste a token instead",
    "ownServers.setToken": "Set token",
    "ownServers.replaceToken": "Replace token",
    "ownServers.stateNoToken": "Token missing"
  },
  de: {
    "ownServers.title": "Deine MCP-Server",
    "ownServers.description":
      "MCP-Server, die du selbst hinzugefügt hast. Nur du nutzt sie, in deinen privaten Chats.",
    "ownServers.add": "MCP-Server hinzufügen",
    "ownServers.empty": "Du hast noch keinen MCP-Server hinzugefügt.",
    "ownServers.addressLabel": "Adresse",
    "ownServers.addressHint": "Die Adresse des Servers, etwa https://example.com/mcp.",
    "ownServers.addressPlaceholder": "https://example.com/mcp",
    "ownServers.connect": "Verbinden",
    "ownServers.checking": "{host} wird kontaktiert …",
    "ownServers.addressEmpty": "Gib die Adresse des Servers ein.",
    "ownServers.addressInvalid": "Das ist keine Webadresse wie https://example.com/mcp.",
    "ownServers.addressCredentials":
      "Lass Name und Passwort aus der Adresse weg: Du meldest dich im nächsten Schritt an.",
    "ownServers.addressQuery": "Lass alles ab ? oder # weg.",
    "ownServers.unreachable": "{host} hat nicht als MCP-Server geantwortet. Prüf die Adresse.",
    "ownServers.egress":
      "Eigene MCP-Server dürfen {host} hier nicht erreichen. Nutze eine öffentliche https-Adresse oder frag eine Administratorin oder einen Administrator.",
    "ownServers.noSignIn":
      "{host} verlangt keine Anmeldung. Ein Server ohne Anmeldung lässt sich noch nicht hinzufügen.",
    "ownServers.limit":
      "Du hast {limit} MCP-Server hinzugefügt, mehr sind hier nicht erlaubt. Entferne zuerst einen.",
    "ownServers.off": "Eigene MCP-Server sind hier abgeschaltet.",
    "ownServers.failed": "Das Hinzufügen hat nicht geklappt. Versuch es noch einmal.",
    "ownServers.reading": "Tools werden gelesen …",
    "ownServers.nameLabel": "Name",
    "ownServers.nameHint": "So heißt der Server für dich und deine Agents.",
    "ownServers.toolsText":
      "Wähle, was deine Agents in deinen privaten Chats nutzen dürfen. Ein Tool, das etwas ändert, fragt dich vor jedem Aufruf.",
    "ownServers.noTools": "Der Server nennt keine Tools.",
    "ownServers.toolsLate":
      "Die Tools sind noch nicht da. Wähle sie später mit Tools ändern auf der Karte des Servers.",
    "ownServers.done": "Fertig",
    "ownServers.stateOff": "Abgeschaltet",
    "ownServers.offText": "Abgeschaltet. Deine Agents nutzen ihn nicht.",
    "ownServers.toolCount": "{count} Tools",
    "ownServers.toolCountOne": "1 Tool",
    "ownServers.changeTools": "Tools ändern",
    "ownServers.remove": "Entfernen",
    "ownServers.removeTitle": "{title} entfernen?",
    "ownServers.removeText":
      "Deine Agents können diesen Server dann nicht mehr nutzen. Deine Anmeldung dort endet, und der Server wird hier gelöscht.",
    "ownServers.removeFailed": "Das Entfernen hat nicht geklappt.",
    "ownServers.toolsTitle": "Tools von {title}",
    "ownServers.askAgain": "Wieder fragen",
    "ownServers.readAgain": "Tools neu lesen",
    "ownServers.save": "Speichern",
    "ownServers.saveFailed": "Das Speichern hat nicht geklappt.",
    "ownServers.proposalLabel": "MCP-Server hinzufügen",
    "ownServers.proposalOpen": "Öffnen",
    "ownServers.proposalNote":
      "Dort verbindest du, meldest dich an und wählst die Tools. Vorher wird nichts gespeichert.",
    "ownServers.proposalReader":
      "Nur die Person, deren Chat das ist, fügt ihren eigenen MCP-Server hinzu.",
    "ownServers.toldTools":
      "Ich habe meinen MCP-Server {title} hinzugefügt. {count} Tools akzeptiert: {tools}.",
    "ownServers.toldOne":
      "Ich habe meinen MCP-Server {title} hinzugefügt. 1 Tool akzeptiert: {tools}.",
    "ownServers.toldNoTools":
      "Ich habe meinen MCP-Server {title} hinzugefügt, noch ohne akzeptierte Tools.",
    "ownServers.toldName": "„{name}“",
    "ownServers.toldMore": "+ {count} weitere",
    "ownServers.loadFailed": "Die Tools ließen sich nicht laden.",
    "ownServers.tokenTitle": "Token für {host}",
    "ownServers.tokenText":
      "{host} nimmt einen Token von dir. Füg den ein, den dir der Dienst gegeben hat.",
    "ownServers.tokenLabel": "Token",
    "ownServers.tokenHint":
      "Er wird verschlüsselt gespeichert, nur an {host} gesendet und nie wieder angezeigt.",
    "ownServers.tokenEmpty": "Füg den Token ein.",
    "ownServers.tokenDetails": "Technische Details",
    "ownServers.headerLabel": "Header",
    "ownServers.headerHint":
      "Leer oder Authorization: Der Token geht auf dem üblichen Weg mit. Sonst der Header, den der Dienst dafür nennt.",
    "ownServers.headerInvalid":
      "Ein Header-Name besteht aus Buchstaben, Ziffern und Bindestrichen, vorn ein Buchstabe.",
    "ownServers.tokenRefused":
      "{host} hat den Token abgelehnt. Prüf ihn und füg ihn noch einmal ein.",
    "ownServers.tokenFailed": "Der Token ließ sich nicht speichern.",
    "ownServers.useToken": "Stattdessen Token einfügen",
    "ownServers.setToken": "Token setzen",
    "ownServers.replaceToken": "Token ersetzen",
    "ownServers.stateNoToken": "Token fehlt"
  }
});
