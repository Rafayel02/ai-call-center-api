-- AlterTable: fingerprint every stored recording so an exact copy can be refused.
ALTER TABLE "dataset_samples" ADD COLUMN "audio_sha256" TEXT;

UPDATE "dataset_samples" SET "audio_sha256" = encode(sha256("audio"), 'hex');

ALTER TABLE "dataset_samples" ALTER COLUMN "audio_sha256" SET NOT NULL;

-- CreateIndex: not unique, so copies that already exist cannot make this migration fail.
CREATE INDEX "dataset_samples_audio_sha256_idx" ON "dataset_samples"("audio_sha256");
