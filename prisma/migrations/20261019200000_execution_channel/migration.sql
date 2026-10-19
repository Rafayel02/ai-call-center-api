-- CreateEnum
CREATE TYPE "ExecutionChannel" AS ENUM ('BROWSER', 'PHONE');

-- A phone call has no user who pressed Play, so started_by becomes optional. Existing rows are Play runs.
ALTER TABLE "scenario_executions" ADD COLUMN "channel" "ExecutionChannel" NOT NULL DEFAULT 'BROWSER',
ADD COLUMN "menu_choice" TEXT,
ALTER COLUMN "started_by" DROP NOT NULL;
