ALTER TABLE "scenarios" ADD COLUMN "voice_prompts" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "scenarios" ADD COLUMN "voice_sources" JSONB NOT NULL DEFAULT '[]';
