-- CreateEnum
CREATE TYPE "GovernanceBatchStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "GovernanceSubjectStatus" AS ENUM ('pending', 'completed', 'held', 'failed');

-- CreateEnum
CREATE TYPE "ActionRiskLevel" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "ActionExecutionStatus" AS ENUM ('planned', 'held', 'skipped', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "GovernanceBatch" (
    "id" TEXT NOT NULL,
    "status" "GovernanceBatchStatus" NOT NULL DEFAULT 'running',
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "input" JSONB NOT NULL,
    "summary" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GovernanceBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovernanceSubject" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "personSlug" TEXT NOT NULL,
    "businessUpdatedAt" TIMESTAMP(3) NOT NULL,
    "diagnosisRunId" TEXT,
    "status" "GovernanceSubjectStatus" NOT NULL DEFAULT 'pending',
    "riskLevel" "ActionRiskLevel",
    "findings" JSONB,
    "actionBundle" JSONB,
    "holdReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GovernanceSubject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionExecution" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "actionCode" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "ActionExecutionStatus" NOT NULL DEFAULT 'planned',
    "action" JSONB NOT NULL,
    "result" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GovernanceBatch_status_startedAt_idx" ON "GovernanceBatch"("status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GovernanceSubject_batchId_personId_key" ON "GovernanceSubject"("batchId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "GovernanceSubject_diagnosisRunId_key" ON "GovernanceSubject"("diagnosisRunId");

-- CreateIndex
CREATE INDEX "GovernanceSubject_personId_completedAt_idx" ON "GovernanceSubject"("personId", "completedAt");

-- CreateIndex
CREATE INDEX "GovernanceSubject_status_completedAt_idx" ON "GovernanceSubject"("status", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActionExecution_subjectId_actionCode_key" ON "ActionExecution"("subjectId", "actionCode");

-- CreateIndex
CREATE INDEX "ActionExecution_subjectId_createdAt_idx" ON "ActionExecution"("subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "ActionExecution_idempotencyKey_status_idx" ON "ActionExecution"("idempotencyKey", "status");

-- CreateIndex
CREATE INDEX "ActionExecution_status_createdAt_idx" ON "ActionExecution"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "GovernanceSubject" ADD CONSTRAINT "GovernanceSubject_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "GovernanceBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GovernanceSubject" ADD CONSTRAINT "GovernanceSubject_diagnosisRunId_fkey" FOREIGN KEY ("diagnosisRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionExecution" ADD CONSTRAINT "ActionExecution_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "GovernanceSubject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
