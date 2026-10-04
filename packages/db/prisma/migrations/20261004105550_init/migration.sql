-- CreateEnum
CREATE TYPE "PrincipalKind" AS ENUM ('agent', 'human', 'service');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'AWAITING_APPROVAL', 'APPLIED', 'REJECTED', 'BLOCKED', 'NEEDS_CLARIFICATION', 'FAILED');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'APPLYING', 'APPLIED', 'FAILED');

-- CreateEnum
CREATE TYPE "Decision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "principals" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" "PrincipalKind" NOT NULL,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "principals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grants" (
    "principal_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grants_pkey" PRIMARY KEY ("principal_id","scope")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL,
    "mode" TEXT NOT NULL,
    "model" TEXT,
    "thread_id" TEXT NOT NULL,
    "outcome" JSONB,
    "summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_calls" (
    "id" TEXT NOT NULL,
    "run_id" TEXT,
    "tenant_id" TEXT NOT NULL,
    "principal_id" TEXT NOT NULL,
    "server" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "node" TEXT,
    "args" JSONB NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,
    "result" JSONB,
    "latency_ms" DOUBLE PRECISION NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "model_turn_id" TEXT,
    "trace_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT,
    "proposed_by" TEXT NOT NULL,
    "order_id" TEXT,
    "base_updated_datetime" TEXT,
    "request" JSONB NOT NULL,
    "diff" JSONB NOT NULL,
    "destructive" BOOLEAN NOT NULL,
    "rationale" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "status" "PlanStatus" NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "decision" "Decision" NOT NULL,
    "approver_id" TEXT NOT NULL,
    "plan_hash" TEXT NOT NULL,
    "acknowledge_destructive" BOOLEAN NOT NULL,
    "note" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "principals_tenant_id_idx" ON "principals"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "runs_thread_id_key" ON "runs"("thread_id");

-- CreateIndex
CREATE INDEX "runs_tenant_id_created_at_idx" ON "runs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "tool_calls_run_id_started_at_idx" ON "tool_calls"("run_id", "started_at");

-- CreateIndex
CREATE INDEX "tool_calls_tenant_id_started_at_idx" ON "tool_calls"("tenant_id", "started_at");

-- CreateIndex
CREATE INDEX "plans_tenant_id_status_idx" ON "plans"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "approvals_plan_id_key" ON "approvals"("plan_id");

-- AddForeignKey
ALTER TABLE "principals" ADD CONSTRAINT "principals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grants" ADD CONSTRAINT "grants_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
