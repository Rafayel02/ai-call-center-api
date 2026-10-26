CREATE TABLE "scenario_knowledge" (
    "id" UUID NOT NULL,
    "scenario_id" UUID NOT NULL,
    "source_name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "embedding" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scenario_knowledge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "scenario_knowledge_scenario_id_idx" ON "scenario_knowledge"("scenario_id");

ALTER TABLE "scenario_knowledge" ADD CONSTRAINT "scenario_knowledge_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
