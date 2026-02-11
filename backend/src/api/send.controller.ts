import { Elysia, t } from "elysia";
import { prisma } from "../services/postgres.service";
import { BaileysService } from "../services/baileys.service";

/**
 * Send Controller — API endpoint for n8n to send WhatsApp messages.
 * 
 * n8n calls POST /send with the bot's API key to send messages
 * back to WhatsApp users through the Conduit gateway.
 */

export const sendController = new Elysia({ prefix: "/send" })
    .post("/", async ({ body, headers, set }) => {
        const apiKey = headers["x-api-key"];

        if (!apiKey) {
            set.status = 401;
            return { error: "Missing X-API-Key header" };
        }

        const { botId, to, type, content, mediaUrl, caption } = body;

        // 1. Validate API Key against the bot
        const bot = await prisma.bot.findUnique({
            where: { id: botId }
        });

        if (!bot) {
            set.status = 404;
            return { error: "Bot not found" };
        }

        if (bot.apiKey !== apiKey) {
            set.status = 403;
            return { error: "Invalid API key for this bot" };
        }

        // 2. Check bot is connected
        const session = BaileysService.getSession(botId);
        if (!session) {
            set.status = 503;
            return { error: "Bot is not connected to WhatsApp" };
        }

        // 3. Build message payload based on type
        let waPayload: any;
        const msgType = type.toUpperCase();

        switch (msgType) {
            case "TEXT":
                waPayload = { text: content || "" };
                break;

            case "IMAGE":
                if (!mediaUrl) {
                    set.status = 400;
                    return { error: "mediaUrl is required for IMAGE type" };
                }
                waPayload = { image: { url: mediaUrl }, caption: caption || content || "" };
                break;

            case "AUDIO":
                if (!mediaUrl) {
                    set.status = 400;
                    return { error: "mediaUrl is required for AUDIO type" };
                }
                waPayload = { audio: { url: mediaUrl }, ptt: false };
                break;

            case "PTT":
                if (!mediaUrl) {
                    set.status = 400;
                    return { error: "mediaUrl is required for PTT type" };
                }
                waPayload = { audio: { url: mediaUrl }, ptt: true };
                break;

            case "VIDEO":
                if (!mediaUrl) {
                    set.status = 400;
                    return { error: "mediaUrl is required for VIDEO type" };
                }
                waPayload = { video: { url: mediaUrl }, caption: caption || content || "" };
                break;

            case "DOCUMENT":
                if (!mediaUrl) {
                    set.status = 400;
                    return { error: "mediaUrl is required for DOCUMENT type" };
                }
                waPayload = { document: { url: mediaUrl }, fileName: caption || "document" };
                break;

            default:
                set.status = 400;
                return { error: `Unsupported message type: ${type}` };
        }

        // 4. Send via Baileys
        try {
            // Normalize the 'to' JID
            const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;

            await BaileysService.sendMessage(botId, jid, waPayload);

            // 5. Log the outgoing message
            const dbSession = await prisma.session.findUnique({
                where: {
                    botId_identifier: {
                        botId,
                        identifier: jid
                    }
                }
            });

            if (dbSession) {
                await prisma.message.create({
                    data: {
                        externalId: `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        sessionId: dbSession.id,
                        sender: bot.identifier,
                        fromMe: true,
                        content: content || caption || "",
                        type: msgType,
                        isProcessed: true,
                        forwardedAt: new Date()
                    }
                });
            }

            console.log(`[Send] ${msgType} sent to ${jid} via Bot ${bot.name}`);
            return { success: true, to: jid, type: msgType };

        } catch (error: any) {
            console.error(`[Send] Failed to send message:`, error.message);
            set.status = 500;
            return { error: `Failed to send: ${error.message}` };
        }
    }, {
        body: t.Object({
            botId: t.String(),
            to: t.String(),
            type: t.String(),
            content: t.Optional(t.String()),
            mediaUrl: t.Optional(t.String()),
            caption: t.Optional(t.String())
        })
    });
