-- CreateEnum
CREATE TYPE "SttCheckStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- AlterTable: every row stored so far is a successful check.
ALTER TABLE "speech_to_text_results" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "last_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "model_id" UUID,
ADD COLUMN     "status" "SttCheckStatus" NOT NULL DEFAULT 'SUCCEEDED',
ALTER COLUMN "transcript" DROP NOT NULL;

UPDATE "speech_to_text_results" SET "last_attempt_at" = "created_at";

ALTER TABLE "speech_to_text_results" ALTER COLUMN "status" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "speech_to_text_results_model_id_last_attempt_at_idx" ON "speech_to_text_results"("model_id", "last_attempt_at");

-- AddForeignKey
ALTER TABLE "speech_to_text_results" ADD CONSTRAINT "speech_to_text_results_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "speech_to_text_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;
