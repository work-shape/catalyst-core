import { publishQuestionsLeadWithTheSentence } from "./publish-narrative-fixtures";
import { test } from "./test";

// PUBQ-1 with accounts of its own: it reads only the held publish it makes, so it needs no
// place in the serial Inbox journey, and a shard can run it beside that journey.
test(
  "PUBQ-1: every publish question leads with the plain sentence in the reader's language, the lists behind Details",
  publishQuestionsLeadWithTheSentence
);
