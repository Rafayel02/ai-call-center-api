CREATE TYPE "PhoneStreamProvider" AS ENUM ('TWILIO');

CREATE TABLE "phone_streaming_services" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "PhoneStreamProvider" NOT NULL,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,

    CONSTRAINT "phone_streaming_services_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "phone_streaming_services_provider_idx" ON "phone_streaming_services"("provider");
CREATE INDEX "phone_streaming_services_created_by_idx" ON "phone_streaming_services"("created_by");

ALTER TABLE "phone_streaming_services" ADD CONSTRAINT "phone_streaming_services_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "phone_calls" (
    "id" UUID NOT NULL,
    "call_sid" TEXT NOT NULL,
    "from_number" TEXT,
    "to_number" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_calls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "phone_calls_call_sid_key" ON "phone_calls"("call_sid");
CREATE INDEX "phone_calls_received_at_idx" ON "phone_calls"("received_at");
