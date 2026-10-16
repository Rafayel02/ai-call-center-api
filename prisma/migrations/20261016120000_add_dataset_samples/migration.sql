-- CreateTable
CREATE TABLE "dataset_samples" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "transcript" TEXT NOT NULL,
    "audio" BYTEA NOT NULL,
    "mime_type" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "dataset_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dataset_samples_created_by_idx" ON "dataset_samples"("created_by");

-- AddForeignKey
ALTER TABLE "dataset_samples" ADD CONSTRAINT "dataset_samples_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
