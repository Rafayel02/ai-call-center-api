-- CreateEnum
CREATE TYPE "TtsProvider" AS ENUM ('ELEVENLABS');

-- CreateTable
CREATE TABLE "text_to_speech_models" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "TtsProvider" NOT NULL,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,

    CONSTRAINT "text_to_speech_models_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "text_to_speech_models_provider_idx" ON "text_to_speech_models"("provider");

-- CreateIndex
CREATE INDEX "text_to_speech_models_created_by_idx" ON "text_to_speech_models"("created_by");

-- AddForeignKey
ALTER TABLE "text_to_speech_models" ADD CONSTRAINT "text_to_speech_models_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
