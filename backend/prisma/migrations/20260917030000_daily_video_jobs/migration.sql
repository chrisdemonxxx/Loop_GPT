-- Extend the existing prepaid queue without rewriting historical jobs or holds.
ALTER TABLE "DailyReservation" ADD COLUMN "requestFingerprint" TEXT,
  ADD COLUMN "pricingSnapshot" JSONB;
ALTER TABLE "AccountedVideoJob" ALTER COLUMN "reservationId" DROP NOT NULL,
  ADD COLUMN "dailyReservationId" TEXT;
CREATE UNIQUE INDEX "AccountedVideoJob_dailyReservationId_key" ON "AccountedVideoJob"("dailyReservationId");
ALTER TABLE "AccountedVideoJob" ADD CONSTRAINT "AccountedVideoJob_dailyReservationId_fkey"
  FOREIGN KEY ("dailyReservationId") REFERENCES "DailyReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountedVideoJob" ADD CONSTRAINT "AccountedVideoJob_one_ledger"
  CHECK (num_nonnulls("reservationId", "dailyReservationId") = 1);

-- Refunds must use the original debit/window, never later edited financial data.
-- State, metrics, model and request snapshots can still follow existing workflows.
CREATE FUNCTION daily_reservation_debit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."userId", NEW."credits", NEW."imageCredits", NEW."bypass", NEW."windowStart")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."userId", OLD."credits", OLD."imageCredits", OLD."bypass", OLD."windowStart") THEN
    RAISE EXCEPTION 'Immutable daily reservation debit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER daily_reservation_debit_immutable BEFORE UPDATE ON "DailyReservation"
  FOR EACH ROW EXECUTE FUNCTION daily_reservation_debit_immutable();
