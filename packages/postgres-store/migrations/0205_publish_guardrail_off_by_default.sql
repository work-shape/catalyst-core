-- PUB-LIVE-1: a publish goes live directly. The shipped guardrail "Publishing needs an instance
-- admin's approval" is off where nobody switched it, so every instance starts from that default:
-- its stored switches go, the ones that kept it on included. An instance admin can switch it on
-- again on Build > Guardrails. The audit events of the earlier switches stay. The table keeps its
-- shape; an older release reads no row as the guardrail on, the safe side of a rollback.
-- contract-after: v0.6.3
DELETE FROM "shipped_guardrail_switches" WHERE "guardrail_name" = 'publishing-needs-approval';
