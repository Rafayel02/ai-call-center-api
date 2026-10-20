ALTER TABLE "scenario_executions" ADD COLUMN "price_usd" DECIMAL(12,6),
ADD COLUMN "price_complete" BOOLEAN NOT NULL DEFAULT false;
