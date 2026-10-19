-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('RUNNING', 'FINISHED', 'STOPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "ExecutionAudioKind" AS ENUM ('CALLER', 'MIX', 'UTTERANCE', 'TTS');

-- CreateTable
CREATE TABLE "scenario_executions" (
    "id" UUID NOT NULL,
    "scenario_id" UUID NOT NULL,
    "started_by" UUID NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration_ms" INTEGER,
    "inquiry" TEXT,
    "topic_id" TEXT,
    "topic_label" TEXT,
    "error_message" TEXT,
    "graph" JSONB NOT NULL,
    "peaks" JSONB,
    "caller_mime" TEXT,
    "mix_mime" TEXT,

    CONSTRAINT "scenario_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenario_execution_audio" (
    "id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "kind" "ExecutionAudioKind" NOT NULL,
    "mime_type" TEXT NOT NULL,
    "audio" BYTEA NOT NULL,
    "byte_size" INTEGER NOT NULL,

    CONSTRAINT "scenario_execution_audio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenario_execution_events" (
    "id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "client_seq" INTEGER NOT NULL,
    "offset_ms" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "node_id" TEXT,
    "payload" JSONB NOT NULL,
    "audio_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scenario_execution_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scenario_executions_scenario_id_started_at_idx" ON "scenario_executions"("scenario_id", "started_at");

-- CreateIndex
CREATE INDEX "scenario_executions_started_by_idx" ON "scenario_executions"("started_by");

-- CreateIndex
CREATE INDEX "scenario_execution_audio_execution_id_idx" ON "scenario_execution_audio"("execution_id");

-- One caller track and one mix per execution. Utterances and clips are unlimited.
CREATE UNIQUE INDEX "scenario_execution_audio_caller_mix_key" ON "scenario_execution_audio"("execution_id", "kind") WHERE "kind" IN ('CALLER', 'MIX');

-- CreateIndex
CREATE INDEX "scenario_execution_events_execution_id_offset_ms_client_seq_idx" ON "scenario_execution_events"("execution_id", "offset_ms", "client_seq");

-- CreateIndex
CREATE UNIQUE INDEX "scenario_execution_events_execution_id_client_seq_key" ON "scenario_execution_events"("execution_id", "client_seq");

-- AddForeignKey
ALTER TABLE "scenario_executions" ADD CONSTRAINT "scenario_executions_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_executions" ADD CONSTRAINT "scenario_executions_started_by_fkey" FOREIGN KEY ("started_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_execution_audio" ADD CONSTRAINT "scenario_execution_audio_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "scenario_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_execution_events" ADD CONSTRAINT "scenario_execution_events_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "scenario_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_execution_events" ADD CONSTRAINT "scenario_execution_events_audio_id_fkey" FOREIGN KEY ("audio_id") REFERENCES "scenario_execution_audio"("id") ON DELETE SET NULL ON UPDATE CASCADE;
