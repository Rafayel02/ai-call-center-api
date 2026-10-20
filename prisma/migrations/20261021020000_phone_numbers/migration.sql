ALTER TABLE "phone_calls" ADD COLUMN "scenario_id" UUID;

CREATE INDEX "phone_calls_scenario_id_idx" ON "phone_calls"("scenario_id");

ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "phone_numbers" (
    "id" UUID NOT NULL,
    "e164" TEXT NOT NULL,
    "streaming_service_id" UUID NOT NULL,
    "scenario_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_numbers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "phone_numbers_e164_key" ON "phone_numbers"("e164");
CREATE UNIQUE INDEX "phone_numbers_scenario_id_key" ON "phone_numbers"("scenario_id");
CREATE INDEX "phone_numbers_streaming_service_id_idx" ON "phone_numbers"("streaming_service_id");

ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_streaming_service_id_fkey" FOREIGN KEY ("streaming_service_id") REFERENCES "phone_streaming_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
