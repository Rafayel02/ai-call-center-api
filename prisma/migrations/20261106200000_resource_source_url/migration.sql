ALTER TABLE "organization_resources" ADD COLUMN "source_url" TEXT;

CREATE UNIQUE INDEX "organization_resources_organization_id_source_url_key" ON "organization_resources"("organization_id", "source_url");
