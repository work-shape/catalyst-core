-- Expand: a hit may say the outcome its guardrail answered where the action could not wait for
-- an approval and the hit is the block it was answered as. A nullable column without a default
-- adds no scan; a release before this one writes no value and reads none.
ALTER TABLE "guardrail_hits" ADD COLUMN "converted_from" text;
