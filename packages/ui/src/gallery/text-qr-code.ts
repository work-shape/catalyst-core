/** The gallery's text for the QrCode entry. */
export interface QrCodeGalleryText {
  qrCodeAuthenticator: string;
  qrCodeSmall: string;
  qrCodeLabel: string;
  qrCodeNote: string;
}

export const qrCodeGalleryText: Record<"en" | "de", QrCodeGalleryText> = {
  en: {
    qrCodeAuthenticator: "An address for an authenticator app",
    qrCodeSmall: "128 pixels",
    qrCodeLabel: "QR code for the authenticator app",
    qrCodeNote:
      "Drawn in the browser, black on white in both modes. Show the key as text beside it for anyone who cannot scan."
  },
  de: {
    qrCodeAuthenticator: "Eine Adresse für eine Authenticator-App",
    qrCodeSmall: "128 Pixel",
    qrCodeLabel: "QR-Code für die Authenticator-App",
    qrCodeNote:
      "Im Browser gezeichnet, schwarz auf weiß in beiden Modi. Zeig den Schlüssel daneben als Text für alle, die nicht scannen können."
  }
};
