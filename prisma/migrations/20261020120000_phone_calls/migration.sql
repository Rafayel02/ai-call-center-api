-- CreateEnum
CREATE TYPE "CallEndReason" AS ENUM ('COMPLETED', 'CALLER_HUNG_UP', 'ERROR', 'NO_SCENARIO');

-- CreateEnum
CREATE TYPE "CallbackReason" AS ENUM ('TURN_LIMIT', 'SILENCE', 'DEFAULT_TOPIC', 'ERROR');

-- CreateTable
CREATE TABLE "phone_numbers" (
    "id" UUID NOT NULL,
    "e164" TEXT NOT NULL,
    "scenario_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" UUID NOT NULL,
    "execution_id" UUID,
    "phone_number_id" UUID,
    "provider_call_id" TEXT NOT NULL,
    "from_number" TEXT,
    "to_number" TEXT NOT NULL,
    "end_reason" "CallEndReason",
    "error" TEXT,
    "callback_reason" "CallbackReason",
    "called_back_at" TIMESTAMP(3),
    "called_back_by_id" UUID,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_e164_key" ON "phone_numbers"("e164");

-- CreateIndex
CREATE INDEX "phone_numbers_scenario_id_idx" ON "phone_numbers"("scenario_id");

-- CreateIndex
CREATE UNIQUE INDEX "calls_execution_id_key" ON "calls"("execution_id");

-- CreateIndex
CREATE UNIQUE INDEX "calls_provider_call_id_key" ON "calls"("provider_call_id");

-- CreateIndex
CREATE INDEX "calls_started_at_idx" ON "calls"("started_at");

-- CreateIndex
CREATE INDEX "calls_callback_reason_called_back_at_idx" ON "calls"("callback_reason", "called_back_at");

-- AddForeignKey
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "scenario_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_called_back_by_id_fkey" FOREIGN KEY ("called_back_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

