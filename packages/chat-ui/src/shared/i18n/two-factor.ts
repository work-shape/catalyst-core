import { defineTranslations } from "./translation-area";

/** Two-factor sign-in: the second sign-in step, the setup, Settings > You and the admin reset. */
export const twoFactor = defineTranslations({
  en: {
    "twoFactor.title": "Two-factor sign-in",
    "twoFactor.setupTitle": "Set up two-factor sign-in",
    "twoFactor.setupRequired":
      "A code from an authenticator app is required at every sign-in. Set it up to continue.",
    "twoFactor.passwordStep": "Confirm with your password to start.",
    "twoFactor.continue": "Continue",
    "twoFactor.scan":
      "Scan the code with an authenticator app, such as Microsoft Authenticator, Google Authenticator or 1Password. Then enter the six digits it shows.",
    "twoFactor.qrLabel": "QR code for your authenticator app",
    "twoFactor.key": "Or enter this key by hand",
    "twoFactor.code": "Code from the app",
    "twoFactor.confirmCode": "Confirm code",
    "twoFactor.backupCodesTitle": "Save your backup codes",
    "twoFactor.backupCodesNote":
      "Each code signs you in once in place of the app, for when you lose your phone. They are shown only now.",
    "twoFactor.copyCodes": "Copy codes",
    "twoFactor.codesCopied": "Copied",
    "twoFactor.downloadCodes": "Download",
    "twoFactor.codesFileHeading": "Backup codes for {name}. Each code works once.",
    "twoFactor.savedCodes": "I have saved the codes",
    "twoFactor.signInCodeTitle": "Enter the code from your authenticator app",
    "twoFactor.backupCodeTitle": "Enter one of your backup codes",
    "twoFactor.backupCode": "Backup code",
    "twoFactor.trustBrowser": "Trust this browser for 30 days",
    "twoFactor.trustBrowserHint": "Only on a device that is yours alone.",
    "twoFactor.useBackupCode": "Use a backup code",
    "twoFactor.useAppCode": "Use the code from the app",
    "twoFactor.verify": "Confirm",
    "twoFactor.codeInvalid": "The code is wrong or has expired. Enter the one the app shows now.",
    "twoFactor.backupCodeInvalid": "This backup code is wrong or was used already.",
    "twoFactor.locked": "Too many wrong codes. Wait 15 minutes, then sign in again.",
    "twoFactor.rateLimited": "Too many tries from this address. Wait a minute, then try again.",
    "twoFactor.challengeExpired": "This sign-in has expired. Sign in again with your password.",
    "twoFactor.passwordWrong": "The password is wrong.",
    "twoFactor.on": "On",
    "twoFactor.off": "Off",
    "twoFactor.offDescription":
      "After your password, your sign-in also asks for a code from an authenticator app on your phone.",
    "twoFactor.onDescription":
      "Your sign-in asks for a code from your authenticator app. To move to a new phone, turn it off and set it up again.",
    "twoFactor.setUp": "Set up",
    "twoFactor.cancelSetup": "Cancel",
    "twoFactor.enabled": "Two-factor sign-in is on.",
    "twoFactor.regenerate": "New backup codes",
    "twoFactor.regenerateDone": "Your old backup codes no longer work.",
    "twoFactor.forgetBrowsers": "Stop trusting all browsers",
    "twoFactor.forgetBrowsersDone": "Every browser asks for the code at its next sign-in.",
    "twoFactor.turnOff": "Turn off",
    "twoFactor.turnOffRequired":
      "Two-factor sign-in is required: after turning it off you set it up again at once.",
    "twoFactor.turnedOff": "Two-factor sign-in is off.",
    "twoFactor.passwordForChanges": "Your password, for new backup codes or to turn it off",
    "twoFactor.adminSetUp": "Set up",
    "twoFactor.adminNotSetUp": "Not set up",
    "twoFactor.adminDescription":
      "For someone who lost both their phone and their backup codes. They set it up again at their next sign-in.",
    "twoFactor.reset": "Reset two-factor sign-in",
    "twoFactor.resetDialogTitle": "Reset two-factor sign-in of {name}?",
    "twoFactor.resetDialogIdentity":
      "First make sure it is really this person asking: by phone, in person or through another channel you trust.",
    "twoFactor.resetDialogEffect":
      "The reset deletes their authenticator link and backup codes, forgets their trusted browsers and signs them out everywhere.",
    "twoFactor.resetConfirm": "Reset",
    "twoFactor.resetting": "Resetting",
    "twoFactor.resetDone": "Reset. {name} sets up two-factor sign-in again at the next sign-in."
  },
  de: {
    "twoFactor.title": "Zwei-Faktor-Anmeldung",
    "twoFactor.setupTitle": "Zwei-Faktor-Anmeldung einrichten",
    "twoFactor.setupRequired":
      "Bei jeder Anmeldung wird ein Code aus einer Authenticator-App verlangt. Richte sie ein, um weiterzumachen.",
    "twoFactor.passwordStep": "Bestätige zum Start mit deinem Passwort.",
    "twoFactor.continue": "Weiter",
    "twoFactor.scan":
      "Scanne den Code mit einer Authenticator-App, etwa Microsoft Authenticator, Google Authenticator oder 1Password. Gib dann die sechs Ziffern ein, die sie zeigt.",
    "twoFactor.qrLabel": "QR-Code für deine Authenticator-App",
    "twoFactor.key": "Oder tippe diesen Schlüssel ein",
    "twoFactor.code": "Code aus der App",
    "twoFactor.confirmCode": "Code bestätigen",
    "twoFactor.backupCodesTitle": "Backup-Codes sichern",
    "twoFactor.backupCodesNote":
      "Jeder Code meldet dich einmal an Stelle der App an, falls du dein Handy verlierst. Sie werden nur jetzt angezeigt.",
    "twoFactor.copyCodes": "Codes kopieren",
    "twoFactor.codesCopied": "Kopiert",
    "twoFactor.downloadCodes": "Herunterladen",
    "twoFactor.codesFileHeading": "Backup-Codes für {name}. Jeder Code gilt einmal.",
    "twoFactor.savedCodes": "Ich habe die Codes gespeichert",
    "twoFactor.signInCodeTitle": "Gib den Code aus deiner Authenticator-App ein",
    "twoFactor.backupCodeTitle": "Gib einen deiner Backup-Codes ein",
    "twoFactor.backupCode": "Backup-Code",
    "twoFactor.trustBrowser": "Diesem Browser 30 Tage vertrauen",
    "twoFactor.trustBrowserHint": "Nur auf einem Gerät, das nur du benutzt.",
    "twoFactor.useBackupCode": "Backup-Code verwenden",
    "twoFactor.useAppCode": "Code aus der App verwenden",
    "twoFactor.verify": "Bestätigen",
    "twoFactor.codeInvalid":
      "Der Code stimmt nicht oder ist abgelaufen. Gib den ein, den die App jetzt zeigt.",
    "twoFactor.backupCodeInvalid": "Dieser Backup-Code stimmt nicht oder wurde schon benutzt.",
    "twoFactor.locked": "Zu viele falsche Codes. Warte 15 Minuten und melde dich dann neu an.",
    "twoFactor.rateLimited":
      "Zu viele Versuche von dieser Adresse. Warte eine Minute und versuche es dann noch einmal.",
    "twoFactor.challengeExpired":
      "Diese Anmeldung ist abgelaufen. Melde dich noch einmal mit deinem Passwort an.",
    "twoFactor.passwordWrong": "Das Passwort stimmt nicht.",
    "twoFactor.on": "An",
    "twoFactor.off": "Aus",
    "twoFactor.offDescription":
      "Nach dem Passwort fragt deine Anmeldung zusätzlich nach einem Code aus einer Authenticator-App auf deinem Handy.",
    "twoFactor.onDescription":
      "Deine Anmeldung fragt nach einem Code aus deiner Authenticator-App. Für ein neues Handy schalte sie aus und richte sie neu ein.",
    "twoFactor.setUp": "Einrichten",
    "twoFactor.cancelSetup": "Abbrechen",
    "twoFactor.enabled": "Die Zwei-Faktor-Anmeldung ist an.",
    "twoFactor.regenerate": "Backup-Codes neu erzeugen",
    "twoFactor.regenerateDone": "Deine alten Backup-Codes gelten nicht mehr.",
    "twoFactor.forgetBrowsers": "Vertrauen für alle Browser aufheben",
    "twoFactor.forgetBrowsersDone": "Jeder Browser fragt bei der nächsten Anmeldung nach dem Code.",
    "twoFactor.turnOff": "Ausschalten",
    "twoFactor.turnOffRequired":
      "Die Zwei-Faktor-Anmeldung ist vorgeschrieben: nach dem Ausschalten richtest du sie sofort neu ein.",
    "twoFactor.turnedOff": "Die Zwei-Faktor-Anmeldung ist aus.",
    "twoFactor.passwordForChanges": "Dein Passwort, für neue Backup-Codes oder zum Ausschalten",
    "twoFactor.adminSetUp": "Eingerichtet",
    "twoFactor.adminNotSetUp": "Nicht eingerichtet",
    "twoFactor.adminDescription":
      "Für alle, die Handy und Backup-Codes verloren haben. Bei der nächsten Anmeldung richten sie sie neu ein.",
    "twoFactor.reset": "Zwei-Faktor zurücksetzen",
    "twoFactor.resetDialogTitle": "Zwei-Faktor-Anmeldung von {name} zurücksetzen?",
    "twoFactor.resetDialogIdentity":
      "Stell zuerst sicher, dass wirklich diese Person fragt: per Telefon, persönlich oder über einen anderen Weg, dem du vertraust.",
    "twoFactor.resetDialogEffect":
      "Das Zurücksetzen löscht ihre Authenticator-Verknüpfung und Backup-Codes, vergisst ihre vertrauten Browser und meldet sie überall ab.",
    "twoFactor.resetConfirm": "Zurücksetzen",
    "twoFactor.resetting": "Wird zurückgesetzt",
    "twoFactor.resetDone":
      "Zurückgesetzt. {name} richtet die Zwei-Faktor-Anmeldung bei der nächsten Anmeldung neu ein."
  }
});
