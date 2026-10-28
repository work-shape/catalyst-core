import { useAuiState } from "@assistant-ui/react";
import { MessageCircleQuestion } from "lucide-react";
import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Badge,
  Button,
  Card,
  Choice,
  ChoiceList,
  FormNotice,
  IconTile,
  Input
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { NO_QUESTION_ANSWERS, questionAnswers, type AskedQuestion } from "./question";

// The agent's question to the person, as a card in the conversation (ASK-1). Picking an option
// or writing an answer sends it as the person's next message, and the agent goes on from it.
// The card is answered once a message of the person follows it: it then shows the answer and
// takes no other.

/** What the card is handed by the workspace: how the person's answer reaches the conversation. */
export interface QuestionHost {
  /**
   * Sends the person's answer as their message to the conversation the card stands in, queued
   * behind a run that goes (CHAT-CONN-1). Absent without a conversation: the card is read only.
   */
  answer?(text: string): Promise<void>;
}

const QuestionHostContext = createContext<QuestionHost | undefined>(undefined);

export function QuestionHostProvider({
  value,
  children
}: {
  value: QuestionHost | undefined;
  children: ReactNode;
}) {
  return <QuestionHostContext.Provider value={value}>{children}</QuestionHostContext.Provider>;
}

const QuestionAnswersContext = createContext<ReadonlyMap<string, string>>(NO_QUESTION_ANSWERS);

function sameAnswers(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [callId, answer] of a) if (b.get(callId) !== answer) return false;
  return true;
}

/**
 * Reads, over every message of the thread, which questions are answered and with what, so the
 * card of one message knows of the person's message after it.
 */
export function QuestionAnswersProvider({ children }: { children: ReactNode }) {
  const messages = useAuiState((state) => state.thread.messages);
  const kept = useRef<ReadonlyMap<string, string>>(NO_QUESTION_ANSWERS);
  const answers = useMemo(() => {
    const next = questionAnswers(messages);
    if (!sameAnswers(kept.current, next)) kept.current = next;
    return kept.current;
  }, [messages]);
  return (
    <QuestionAnswersContext.Provider value={answers}>{children}</QuestionAnswersContext.Provider>
  );
}

/** The card of one question in the thread. */
export function QuestionCard({ toolCallId, asked }: { toolCallId: string; asked: AskedQuestion }) {
  const host = useContext(QuestionHostContext);
  const answered = useContext(QuestionAnswersContext).get(toolCallId);
  // The answer the person just gave, until the conversation shows their message.
  const [sent, setSent] = useState<string>();
  const [failed, setFailed] = useState(false);
  const send = host?.answer;
  return (
    <QuestionCardView
      asked={asked}
      {...(answered !== undefined || sent !== undefined ? { answer: answered ?? sent } : {})}
      failed={failed}
      {...(send
        ? {
            onAnswer: (text: string) => {
              setSent(text);
              setFailed(false);
              send(text).catch(() => {
                setSent(undefined);
                setFailed(true);
              });
            }
          }
        : {})}
    />
  );
}

/** The card as it shows one question: open with its options, or answered. */
export function QuestionCardView({
  asked,
  answer,
  failed = false,
  onAnswer
}: {
  asked: AskedQuestion;
  /** The person's answer: the card shows it and takes no other. */
  answer?: string;
  /** The last answer could not be sent. */
  failed?: boolean;
  /** Gives an answer; absent where the card cannot send one. */
  onAnswer?: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [own, setOwn] = useState("");
  const ownText = own.trim();
  return (
    <div className="chat-tool-part my-3 max-w-3xl" data-testid="tool-call-card">
      <Card
        padding="md"
        className="min-w-0 overflow-hidden"
        role="group"
        aria-label={asked.question}
        data-testid="question-card"
        data-state={answer === undefined ? "open" : "answered"}
      >
        <div className="flex min-w-0 items-start gap-3 p-4">
          <IconTile>
            <MessageCircleQuestion aria-hidden="true" />
          </IconTile>
          <p className="min-w-0 flex-1 self-center text-label text-foreground wrap-anywhere">
            {asked.question}
          </p>
        </div>
        {answer === undefined ? (
          <div className="grid min-w-0 gap-3 border-t px-4 py-3">
            <ChoiceList label={asked.question}>
              {asked.options.map((option) => (
                <Choice
                  key={option.label}
                  title={option.label}
                  {...(option.description === undefined ? {} : { hint: option.description })}
                  {...(option.recommended
                    ? {
                        mark: (
                          <Badge tone="accent" size="sm">
                            {t("questions.recommended")}
                          </Badge>
                        )
                      }
                    : {})}
                  disabled={!onAnswer}
                  data-question-option={option.label}
                  onClick={() => onAnswer?.(option.label)}
                />
              ))}
            </ChoiceList>
            {onAnswer ? (
              <form
                className="flex min-w-0 items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (ownText.length > 0) onAnswer(ownText);
                }}
              >
                <Input
                  size="sm"
                  value={own}
                  placeholder={t("questions.own")}
                  aria-label={t("questions.own")}
                  data-question-own=""
                  onChange={(event) => setOwn(event.target.value)}
                />
                <Button size="sm" variant="outline" type="submit" disabled={ownText.length === 0}>
                  {t("questions.send")}
                </Button>
              </form>
            ) : null}
            {failed ? <FormNotice tone="error">{t("questions.failed")}</FormNotice> : null}
          </div>
        ) : (
          <div className="grid min-w-0 gap-0.5 border-t px-4 py-3" data-question-answer="">
            <p className="text-caption text-muted-foreground">{t("questions.answered")}</p>
            <p className="line-clamp-4 text-body whitespace-pre-wrap text-foreground wrap-anywhere">
              {answer}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
