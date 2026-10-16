-- AlterTable
ALTER TABLE "dataset_samples" RENAME COLUMN "transcript" TO "sentence";
ALTER TABLE "dataset_samples" DROP COLUMN "name";
ALTER TABLE "dataset_samples" ADD COLUMN "age" TEXT;
ALTER TABLE "dataset_samples" ADD COLUMN "gender" TEXT;
ALTER TABLE "dataset_samples" ADD COLUMN "locale" TEXT;
ALTER TABLE "dataset_samples" ADD COLUMN "source" TEXT;
ALTER TABLE "dataset_samples" ADD COLUMN "external_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "dataset_samples_external_id_key" ON "dataset_samples"("external_id");
CREATE INDEX "dataset_samples_source_idx" ON "dataset_samples"("source");
