-- CreateTable
CREATE TABLE "text_to_speech_clips" (
    "id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "cache_key" TEXT NOT NULL,
    "provider_model_id" TEXT NOT NULL,
    "voice_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "audio" BYTEA NOT NULL,
    "mime_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "text_to_speech_clips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "text_to_speech_clips_cache_key_key" ON "text_to_speech_clips"("cache_key");

-- CreateIndex
CREATE INDEX "text_to_speech_clips_model_id_idx" ON "text_to_speech_clips"("model_id");

-- AddForeignKey
ALTER TABLE "text_to_speech_clips" ADD CONSTRAINT "text_to_speech_clips_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "text_to_speech_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;
