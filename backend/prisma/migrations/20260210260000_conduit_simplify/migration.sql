-- Conduit Simplification: Remove internal flow engine tables, add n8n integration fields

-- Drop old internal flow engine tables (order matters for FK constraints)
DROP TABLE IF EXISTS "Execution" CASCADE;
DROP TABLE IF EXISTS "Step" CASCADE;
DROP TABLE IF EXISTS "Trigger" CASCADE;
DROP TABLE IF EXISTS "Flow" CASCADE;
DROP TABLE IF EXISTS "Client" CASCADE;
DROP TABLE IF EXISTS "CommandLog" CASCADE;

-- Remove old columns from Bot
ALTER TABLE "Bot" DROP COLUMN IF EXISTS "platform";
ALTER TABLE "Bot" DROP COLUMN IF EXISTS "credentials";
ALTER TABLE "Bot" DROP COLUMN IF EXISTS "ipv6Address";

-- Add n8n integration columns to Bot
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "webhookUrl" TEXT;
ALTER TABLE "Bot" ADD COLUMN IF NOT EXISTS "apiKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Bot_apiKey_key" ON "Bot"("apiKey");

-- Remove platform from Session
ALTER TABLE "Session" DROP COLUMN IF EXISTS "platform";
ALTER TABLE "Session" DROP COLUMN IF EXISTS "authData";

-- Add forwardedAt to Message
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "forwardedAt" TIMESTAMP(3);

-- Re-create CommandLog with simplified schema
CREATE TABLE IF NOT EXISTS "CommandLog" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "user" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommandLog_pkey" PRIMARY KEY ("id")
);

-- Drop old enums that are no longer used
DROP TYPE IF EXISTS "Platform" CASCADE;
DROP TYPE IF EXISTS "MatchType" CASCADE;
DROP TYPE IF EXISTS "StepType" CASCADE;
DROP TYPE IF EXISTS "TriggerScope" CASCADE;
DROP TYPE IF EXISTS "ClientStatus" CASCADE;
