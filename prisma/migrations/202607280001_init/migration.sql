-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('running', 'need_clarification', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "AgentEventLevel" AS ENUM ('debug', 'info', 'warn', 'error');

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "graphName" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'running',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "currentNode" TEXT,
    "threadId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCheckpoint" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "nodeName" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "nodeName" TEXT,
    "level" "AgentEventLevel" NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosisResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "personId" TEXT,
    "personSlug" TEXT,
    "status" TEXT NOT NULL,
    "summary" TEXT,
    "findings" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "snapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiagnosisResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentRun_graphName_startedAt_idx" ON "AgentRun"("graphName", "startedAt");

-- CreateIndex
CREATE INDEX "AgentRun_status_startedAt_idx" ON "AgentRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "AgentCheckpoint_runId_createdAt_idx" ON "AgentCheckpoint"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentCheckpoint_nodeName_createdAt_idx" ON "AgentCheckpoint"("nodeName", "createdAt");

-- CreateIndex
CREATE INDEX "AgentEvent_runId_createdAt_idx" ON "AgentEvent"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentEvent_level_createdAt_idx" ON "AgentEvent"("level", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiagnosisResult_runId_key" ON "DiagnosisResult"("runId");

-- CreateIndex
CREATE INDEX "DiagnosisResult_personSlug_idx" ON "DiagnosisResult"("personSlug");

-- CreateIndex
CREATE INDEX "DiagnosisResult_personId_idx" ON "DiagnosisResult"("personId");

-- CreateIndex
CREATE INDEX "DiagnosisResult_status_createdAt_idx" ON "DiagnosisResult"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentCheckpoint" ADD CONSTRAINT "AgentCheckpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEvent" ADD CONSTRAINT "AgentEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosisResult" ADD CONSTRAINT "DiagnosisResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
