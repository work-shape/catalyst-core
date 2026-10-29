import { useEffect, useState } from "react";
import { Button, Field, FormNotice, InlineError, Textarea } from "@work-shape/catalyst-ui";
import { AppCallError, feedback, getContext } from "./client";

// Written feedback on an App for the people who build it (LU-6): a field and a send button. The
// interface names the App and its revision and sends the comment to the App's reviewers with
// the viewer's name; the Page sends only the text. Where the instance has feedback off, or the
// Page is no published App, the component shows nothing.

/** The longest comment the platform takes. */
export const APP_FEEDBACK_MAX_LENGTH = 4000;

const TEXTS = {
  en: {
    label: "Your feedback on this App",
    hint: "The people who build this App read it, with your name.",
    send: "Send feedback",
    sent: "Thank you. Your feedback was sent.",
    another: "Write more",
    tooLong: `Keep it to ${APP_FEEDBACK_MAX_LENGTH} characters.`
  },
  de: {
    label: "Dein Feedback zu dieser App",
    hint: "Die Personen, die diese App bauen, lesen es mit deinem Namen.",
    send: "Feedback senden",
    sent: "Danke. Dein Feedback wurde gesendet.",
    another: "Weiteres schreiben",
    tooLong: `Höchstens ${APP_FEEDBACK_MAX_LENGTH} Zeichen.`
  }
} as const;

type FeedbackTexts = { [Key in keyof (typeof TEXTS)["en"]]: string };

export interface AppFeedbackProps {
  /** The words of the field, where the App words them itself. The interface language otherwise. */
  texts?: Partial<FeedbackTexts>;
  className?: string;
}

/** Whether the viewer can send feedback here, once the interface has told. */
function useFeedbackOffered(): { offered: boolean; locale: string } | undefined {
  const [state, setState] = useState<{ offered: boolean; locale: string }>();
  useEffect(() => {
    let stopped = false;
    getContext().then(
      (context) => {
        if (!stopped) setState({ offered: context.feedback === true, locale: context.locale });
      },
      () => {
        if (!stopped) setState({ offered: false, locale: "en" });
      }
    );
    return () => {
      stopped = true;
    };
  }, []);
  return state;
}

/**
 * A form for written feedback on this App. Place it where people finish a task, or on a page of
 * its own. It sends one comment per click; the person can write more after.
 *
 * ```tsx
 * <AppFeedback />
 * ```
 */
export function AppFeedback({ texts, className }: AppFeedbackProps) {
  const offered = useFeedbackOffered();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  if (!offered?.offered) return null;
  const words: FeedbackTexts = {
    ...(offered.locale.toLowerCase().startsWith("de") ? TEXTS.de : TEXTS.en),
    ...texts
  };
  const trimmed = text.trim();
  const tooLong = trimmed.length > APP_FEEDBACK_MAX_LENGTH;

  if (sent) {
    return (
      <div className={className} data-catalyst-feedback="sent">
        <div className="flex flex-wrap items-center gap-3">
          <FormNotice tone="success">{words.sent}</FormNotice>
          <Button size="sm" variant="ghost" onClick={() => setSent(false)}>
            {words.another}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className={className}
      data-catalyst-feedback="form"
      onSubmit={(event) => {
        event.preventDefault();
        if (sending || trimmed.length === 0 || tooLong) return;
        setSending(true);
        setError(undefined);
        feedback
          .send(trimmed)
          .then(() => {
            setText("");
            setSent(true);
          })
          .catch((failure: unknown) => {
            // The platform's sentence, in the viewer's language where it has one.
            setError(
              failure instanceof AppCallError || failure instanceof Error
                ? failure.message
                : String(failure)
            );
          })
          .finally(() => setSending(false));
      }}
    >
      <div className="grid gap-3">
        <Field label={words.label} hint={words.hint} error={tooLong ? words.tooLong : undefined}>
          <Textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} />
        </Field>
        {error ? <InlineError>{error}</InlineError> : null}
        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={sending || trimmed.length === 0 || tooLong}
          >
            {words.send}
          </Button>
        </div>
      </div>
    </form>
  );
}
