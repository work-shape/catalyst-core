import { QrCode } from "../data/qr-code";
import { Samples, type GalleryEntry } from "./entry";

// A made-up address in the shape an authenticator app reads: no real secret.
const sampleAddress =
  "otpauth://totp/Catalyst:anna%40example.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Catalyst";

export const qrCodeGalleryEntry: GalleryEntry = {
  name: "QrCode",
  components: ["QrCode"],
  render: (text) => (
    <>
      <Samples label={text.qrCodeAuthenticator}>
        <div data-gallery-sample="qr-code" className="grid gap-3 sm:grid-cols-[auto_1fr]">
          <QrCode value={sampleAddress} label={text.qrCodeLabel} />
          <p className="max-w-sm text-body text-muted-foreground">{text.qrCodeNote}</p>
        </div>
      </Samples>
      <Samples label={text.qrCodeSmall}>
        <QrCode value={sampleAddress} label={text.qrCodeLabel} size={128} />
      </Samples>
    </>
  )
};
