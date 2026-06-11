import { Bot, User } from "lucide-react";
import type { Message } from "@vivd-stage/api-client";
import { cn } from "./ui/cn";

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <article
      className={cn(
        "grid grid-cols-[2.25rem_minmax(0,fit-content(48rem))] items-start gap-2.5",
        isUser && "justify-self-end grid-cols-[minmax(0,fit-content(42rem))_2.25rem]"
      )}
    >
      <div
        className={cn(
          "grid size-9 place-items-center rounded-lg border bg-card text-primary",
          isUser && "col-start-2 row-start-1 text-orange-800"
        )}
      >
        {isUser ? <User size={15} aria-hidden="true" /> : <Bot size={15} aria-hidden="true" />}
      </div>
      <p
        className={cn(
          "max-w-3xl whitespace-pre-wrap rounded-md border bg-card px-3.5 py-2.5 text-sm leading-6 shadow-xs [overflow-wrap:anywhere]",
          isUser && "col-start-1 row-start-1 border-orange-200 bg-orange-50"
        )}
      >
        {message.text}
      </p>
    </article>
  );
}
