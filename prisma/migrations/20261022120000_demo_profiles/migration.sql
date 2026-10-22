CREATE TABLE "demo_profiles" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "scenario_id" UUID,
    "default_language" TEXT NOT NULL DEFAULT 'hy',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "accent" TEXT,
    "logo_url" TEXT,
    "copy" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "demo_profiles_key_key" ON "demo_profiles"("key");

CREATE TABLE "demo_sessions" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "scenario_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "execution_id" UUID,
    "allowed_model_ids" TEXT[],
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "demo_sessions_token_hash_key" ON "demo_sessions"("token_hash");
CREATE UNIQUE INDEX "demo_sessions_execution_id_key" ON "demo_sessions"("execution_id");
CREATE INDEX "demo_sessions_expires_at_idx" ON "demo_sessions"("expires_at");

ALTER TABLE "demo_profiles" ADD CONSTRAINT "demo_profiles_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "demo_sessions" ADD CONSTRAINT "demo_sessions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "demo_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "demo_sessions" ADD CONSTRAINT "demo_sessions_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
