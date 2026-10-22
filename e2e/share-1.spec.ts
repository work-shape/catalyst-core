import { shareAsksForWhom } from "./share-1-fixtures";
import { test } from "./test";

// SHARE-1 with accounts of its own: it reads only the held publish it makes, so it needs no
// place in the serial Inbox journey, and a shard can run it beside that journey.
// Layout checks run in three light variants; E2E_SHOTS_DIR enables their pictures.
test(
  "SHARE-1: the Publish dialog asks “For whom?” first, the Inbox names the choice, and the save line shares",
  shareAsksForWhom
);
