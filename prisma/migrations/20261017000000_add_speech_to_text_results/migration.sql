-- CreateTable
CREATE TABLE "speech_to_text_results" (
    "id" UUID NOT NULL,
    "engine_key" TEXT NOT NULL,
    "sample_id" UUID NOT NULL,
    "transcript" TEXT NOT NULL,
    "language_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "speech_to_text_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "speech_to_text_results_sample_id_idx" ON "speech_to_text_results"("sample_id");

-- CreateIndex
CREATE UNIQUE INDEX "speech_to_text_results_engine_key_sample_id_key" ON "speech_to_text_results"("engine_key", "sample_id");

-- AddForeignKey
ALTER TABLE "speech_to_text_results" ADD CONSTRAINT "speech_to_text_results_sample_id_fkey" FOREIGN KEY ("sample_id") REFERENCES "dataset_samples"("id") ON DELETE CASCADE ON UPDATE CASCADE;
