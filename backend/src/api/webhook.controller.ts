import { Elysia, t } from "elysia";
import { prisma } from "../services/postgres.service";
import { queueService } from "../services/queue.service";
import { SessionStatus } from "@prisma/client";

/**
 * Webhook Controller — Receives incoming messages from external sources
 * (e.g. alternative WhatsApp providers) and forwards them to n8n.
 * 
 * Note: Primary message intake is via Baileys (direct WhatsApp connection).
 * This endpoint serves as a fallback/alternative intake route.
 */

export const webhookController = new Elysia({ prefix: "/webhook" })
    .post("/incoming", async ({ body, set }) => {
        const { from, content, type = "text", botId } = body;

        if (!botId) {
            set.status = 400;
            return { error: "botId is required" };
        }

        console.log(`[Webhook] Received ${type} from ${from} for bot ${botId}`);

        try {
            // 1. Resolve Bot
            const bot = await prisma.bot.findUnique({
                where: { id: botId }
            });

            if (!bot) {
                set.status = 404;
                return { error: `Bot '${botId}' not found` };
            }

            // 2. Resolve Session
            const jid = from.includes("@") ? from : `${from}@s.whatsapp.net`;

            let session = await prisma.session.findUnique({
                where: {
                    botId_identifier: {
                        botId: bot.id,
                        identifier: jid
                    }
                }
            });

            if (!session) {
                session = await prisma.session.create({
                    data: {
                        botId: bot.id,
                        identifier: jid,
                        name: `User ${from}`,
                        status: SessionStatus.CONNECTED
                    }
                });
            }

            // 3. Persist Message
            const message = await prisma.message.create({
                data: {
                    externalId: `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    sessionId: session.id,
                    sender: jid,
                    content,
                    type: type.toUpperCase(),
                    isProcessed: false
                }
            });

            // 4. Enqueue for n8n forwarding
            await queueService.enqueueForN8n({
                botId: bot.id,
                botName: bot.name,
                sessionId: session.id,
                messageId: message.id,
                from: jid,
                pushName: "",
                content,
                type: type.toUpperCase() as any,
                timestamp: new Date().toISOString(),
                externalId: message.externalId
            });

            return { status: "received", messageId: message.id, bot: bot.name };

        } catch (err: any) {
            console.error("[Webhook] Error:", err);
            set.status = 500;
            return { error: err.message };
        }
    }, {
        body: t.Object({
            from: t.String(),
            content: t.String(),
            type: t.Optional(t.String()),
            botId: t.String()
        })
    });
