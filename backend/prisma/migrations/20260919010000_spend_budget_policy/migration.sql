-- Spend budget policy singleton + daily reservation window indexes.
-- Mirrors the VideoQueuePolicy contract: DB admins update the singleton,
-- increment revision, obey SQL checks; no environment/worker override.
CREATE TABLE "SpendBudgetPolicy" (
    "id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "perUserDailyReservationCap" BIGINT NOT NULL DEFAULT 1000,
    "globalDailyReservationCap" BIGINT NOT NULL DEFAULT 50000,
    CONSTRAINT "SpendBudgetPolicy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SpendBudgetPolicy_id_check" CHECK ("id" = 1),
    CONSTRAINT "SpendBudgetPolicy_version_check" CHECK ("version" = 1),
    CONSTRAINT "SpendBudgetPolicy_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "SpendBudgetPolicy_perUser_check" CHECK ("perUserDailyReservationCap" >= 0 AND "perUserDailyReservationCap" <= 10000000),
    CONSTRAINT "SpendBudgetPolicy_global_check" CHECK ("globalDailyReservationCap" >= 0 AND "globalDailyReservationCap" <= 10000000)
);
INSERT INTO "SpendBudgetPolicy" ("id", "version", "revision", "perUserDailyReservationCap", "globalDailyReservationCap")
VALUES (1, 1, 1, 1000, 50000);
CREATE INDEX "DailyReservation_userId_windowStart_idx" ON "DailyReservation"("userId", "windowStart");
CREATE INDEX "DailyReservation_windowStart_idx" ON "DailyReservation"("windowStart");
