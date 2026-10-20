CREATE TYPE "ExecutionSource" AS ENUM ('PLAY', 'PHONE');

ALTER TABLE "scenario_executions" ADD COLUMN "source" "ExecutionSource" NOT NULL DEFAULT 'PLAY';
