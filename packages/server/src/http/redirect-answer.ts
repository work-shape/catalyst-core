import { redirectAnswerSchema } from "@work-shape/catalyst-api-contract";
import type { FastifyReply } from "fastify";

/**
 * Answers an operation whose answer is a redirect: `303` to the address the call returned.
 * A refused or failed call goes to the address `onError` names for it, so a browser that
 * arrives from an outside system lands on a page of the instance and never on an error body.
 * Where `onError` names none, the error is answered as for any operation. The answer is never
 * cached and sends no referrer: the address that was called may carry a code and a state.
 */
export async function answerRedirect(
  reply: FastifyReply,
  onError: ((error: unknown) => string | undefined) | undefined,
  call: () => Promise<unknown>
): Promise<FastifyReply> {
  let location: string;
  try {
    location = redirectAnswerSchema.parse(await call()).location;
  } catch (error) {
    const landing = onError?.(error);
    if (landing === undefined) throw error;
    location = landing;
  }
  return reply
    .code(303)
    .header("location", location)
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .send();
}
