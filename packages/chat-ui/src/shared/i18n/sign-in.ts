import { defineTranslations } from "./translation-area";

export const signIn = defineTranslations({
  en: {
    passwordResetDescription:
      "Enter your email address and we will send you a link to set a new password.",
    passwordResetForgot: "Forgot password?",
    passwordResetSend: "Send link",
    passwordResetSent:
      "If an account exists for this address, a link is on its way. It is valid for 60 minutes.",
    passwordResetTitle: "Reset password",
    passwordSetupBack: "Back to sign in",
    passwordSetupDone: "Your password is set. Sign in with it now.",
    passwordSetupFailed: "This link is invalid or has expired. Request a new one.",
    passwordSetupSubmit: "Save password",
    passwordSetupTitle: "Set a new password",
    signIn: "Sign in",
    signInFailed: "Sign in failed",
    signInTo: "Sign in to {clientName}",
    signingIn: "Signing in"
  },
  de: {
    passwordResetDescription:
      "Gib deine E-Mail-Adresse ein. Wir senden dir einen Link, mit dem du ein neues Passwort festlegst.",
    passwordResetForgot: "Passwort vergessen?",
    passwordResetSend: "Link senden",
    passwordResetSent:
      "Falls es zu dieser Adresse ein Konto gibt, ist ein Link unterwegs. Er ist 60 Minuten gültig.",
    passwordResetTitle: "Passwort zurücksetzen",
    passwordSetupBack: "Zurück zur Anmeldung",
    passwordSetupDone: "Dein Passwort ist festgelegt. Melde dich jetzt damit an.",
    passwordSetupFailed: "Dieser Link ist ungültig oder abgelaufen. Fordere einen neuen an.",
    passwordSetupSubmit: "Passwort speichern",
    passwordSetupTitle: "Neues Passwort festlegen",
    signIn: "Anmelden",
    signInFailed: "Anmeldung fehlgeschlagen",
    signInTo: "Bei {clientName} anmelden",
    signingIn: "Anmeldung läuft"
  }
});
