-- CreateEnum
CREATE TYPE "LlmProvider" AS ENUM ('OPENAI');

-- CreateTable
CREATE TABLE "llm_models" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "LlmProvider" NOT NULL,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,

    CONSTRAINT "llm_models_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_models_provider_idx" ON "llm_models"("provider");

-- CreateIndex
CREATE INDEX "llm_models_created_by_idx" ON "llm_models"("created_by");

-- AddForeignKey
ALTER TABLE "llm_models" ADD CONSTRAINT "llm_models_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
