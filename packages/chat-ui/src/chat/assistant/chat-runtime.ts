import type { AssistantRuntime } from "@assistant-ui/react";
import { useChatRuntime, type UseChatRuntimeOptions } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";

const stabilized = new WeakSet<object>();

/**
 * The thread list of an assistant-ui 0.14 runtime answers `getState` with a new object on every
 * call: its `subscribe` bypasses the binding that memoizes the state (fixed upstream in
 * @assistant-ui/core 0.3). @assistant-ui/tap 0.9.13 and later re-read every snapshot after each
 * commit, so with that state the first keystroke in the composer re-renders until "Maximum update
 * depth exceeded. The result of getSnapshot should be cached". A consumer's install can resolve
 * such a tap beside our core 0.2 whatever chat-ui pins, so the state is made stable here: the
 * same object while none of its fields changed, as the upstream fix answers.
 */
export function stabilizeThreadListState<State extends object>(runtime: {
  threads: { getState: () => State };
}): void {
  const threads = runtime.threads;
  if (stabilized.has(threads)) return;
  stabilized.add(threads);
  const read = threads.getState.bind(threads);
  let last: State | undefined;
  threads.getState = () => {
    const next = read();
    if (last !== undefined && sameFields(last, next)) return last;
    last = next;
    return next;
  };
}

function sameFields(left: object, right: object): boolean {
  const keys = Object.keys(right);
  return (
    keys.length === Object.keys(left).length &&
    keys.every((key) => Object.is(Reflect.get(left, key), Reflect.get(right, key)))
  );
}

/** assistant-ui's AI SDK runtime, with a thread list whose state is stable between changes. */
export function useCatalystChatRuntime<UI_MESSAGE extends UIMessage = UIMessage>(
  options?: UseChatRuntimeOptions<UI_MESSAGE>
): AssistantRuntime {
  const runtime = useChatRuntime(options);
  stabilizeThreadListState(runtime);
  return runtime;
}
