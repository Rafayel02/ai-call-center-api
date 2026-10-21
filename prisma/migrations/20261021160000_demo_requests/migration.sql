CREATE TABLE "demo_requests" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "needs" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "demo_requests_created_at_idx" ON "demo_requests"("created_at");
