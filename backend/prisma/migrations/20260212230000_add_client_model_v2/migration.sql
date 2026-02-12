-- Re-create Client table for client management
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "name" TEXT,
    "curp" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "llaveEmail" TEXT,
    "llavePassword" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint on botId + jid
CREATE UNIQUE INDEX "Client_botId_jid_key" ON "Client"("botId", "jid");

-- Add foreign key to Bot
ALTER TABLE "Client" ADD CONSTRAINT "Client_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
