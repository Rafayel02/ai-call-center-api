CREATE TYPE "ResourceStatus" AS ENUM ('INDEXING', 'READY', 'FAILED');

ALTER TABLE "organizations" ADD COLUMN "openai_vector_store_id" TEXT;

CREATE UNIQUE INDEX "organizations_openai_vector_store_id_key" ON "organizations"("openai_vector_store_id");

CREATE TABLE "organization_resources" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "openai_file_id" TEXT NOT NULL,
    "status" "ResourceStatus" NOT NULL DEFAULT 'INDEXING',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "organization_resources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organization_resources_openai_file_id_key" ON "organization_resources"("openai_file_id");

CREATE INDEX "organization_resources_organization_id_idx" ON "organization_resources"("organization_id");

CREATE INDEX "organization_resources_created_by_idx" ON "organization_resources"("created_by");

ALTER TABLE "organization_resources" ADD CONSTRAINT "organization_resources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "organization_resources" ADD CONSTRAINT "organization_resources_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
