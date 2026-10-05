-- Bot computer (user-facing seam, B4): the 'bot' usage kind. Widen the daily
-- settlement ledger's fail-closed kind check so bot-run settlements validate.
-- Constraint body is byte-identical to 20260917000000_daily_settlement_recovery
-- apart from the added 'bot' literal; no data changes.

ALTER TABLE "DailySettlementIntent" DROP CONSTRAINT "daily_intent_metrics";
ALTER TABLE "DailySettlementIntent" ADD CONSTRAINT "daily_intent_metrics" CHECK (
  "tokensIn" >= 0 AND "tokensOut" >= 0 AND "images" >= 0 AND
  "kind" IN ('chat', 'agent', 'research', 'image', 'video', 'bot') AND
  "images" <= CASE WHEN "kind" = 'image' THEN 1 ELSE 0 END AND
  length("model") <= 1024 AND length("fingerprint") = 64 AND "attempts" >= 0
);
