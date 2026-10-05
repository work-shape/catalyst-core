import type { LocaleCode } from "@vivd-catalyst/core";
import type { MailMessage, MailSenderIdentity, MailTemplate, RenderedMail } from "./types";

interface MailCopy {
  subject: string;
  intro: string;
  action: string;
  footer: string;
}

type CopyFor<Template extends MailTemplate> = (
  params: Template["params"],
  productName: string
) => MailCopy;

const copy: {
  [Id in MailTemplate["template"]]: Record<
    LocaleCode,
    CopyFor<Extract<MailTemplate, { template: Id }>>
  >;
} = {
  "password-reset": {
    en: (params, productName) => ({
      subject: `Reset your ${productName} password`,
      intro: `We received a request to reset the password for your ${productName} account.`,
      action: "Set a new password",
      footer: `The link is valid for ${params.validMinutes} minutes and can be used once. If you did not request this, you can ignore this email.`
    }),
    de: (params, productName) => ({
      subject: `Passwort für ${productName} zurücksetzen`,
      intro: `Für dein ${productName}-Konto wurde das Zurücksetzen des Passworts angefordert.`,
      action: "Neues Passwort festlegen",
      footer: `Der Link ist ${params.validMinutes} Minuten gültig und kann einmal verwendet werden. Falls du das nicht angefordert hast, kannst du diese E-Mail ignorieren.`
    })
  },
  "platform-invitation": {
    en: (params, productName) => ({
      subject: `You have been invited to ${productName}`,
      intro: `${params.inviterLabel} has invited you to ${productName}. Set a password to activate your account.`,
      action: "Set password",
      footer: `The link is valid for ${params.validDays} days and can be used once.`
    }),
    de: (params, productName) => ({
      subject: `Einladung zu ${productName}`,
      intro: `${params.inviterLabel} hat dich zu ${productName} eingeladen. Lege ein Passwort fest, um dein Konto zu aktivieren.`,
      action: "Passwort festlegen",
      footer: `Der Link ist ${params.validDays} Tage gültig und kann einmal verwendet werden.`
    })
  }
};

export function renderMail(message: MailMessage, identity: MailSenderIdentity): RenderedMail {
  const resolved = resolveCopy(message, identity.productName);
  const link = message.params.link;
  return {
    to: message.to,
    subject: resolved.subject,
    text: [resolved.intro, `${resolved.action}: ${link}`, resolved.footer].join("\n\n"),
    html: [
      `<p>${escapeHtml(resolved.intro)}</p>`,
      `<p><a href="${escapeHtml(link)}">${escapeHtml(resolved.action)}</a></p>`,
      `<p>${escapeHtml(resolved.footer)}</p>`
    ].join("\n")
  };
}

function resolveCopy(message: MailMessage, productName: string): MailCopy {
  switch (message.template) {
    case "password-reset":
      return copy["password-reset"][message.locale](message.params, productName);
    case "platform-invitation":
      return copy["platform-invitation"][message.locale](message.params, productName);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}
