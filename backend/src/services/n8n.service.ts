import { prisma } from "./postgres.service";
import type { BatchPayload } from "./batcher.service";

/**
 * N8nService — Forwards incoming WhatsApp messages to n8n webhooks.
 * 
 * When a message arrives via Baileys, this service POSTs the message data
 * to the bot's configured n8n webhook URL. n8n then processes the message
 * through its flows and can respond via the /send API endpoint.
 */

export interface N8nWebhookPayload {
    // Bot context
    botId: string;
    botName: string;
    apiKey?: string;        // Bot's API key for n8n to authenticate /send responses

    // Session context
    sessionId: string;

    // Message data
    messageId: string;
    from: string;           // JID of the sender (e.g., 521234567890@s.whatsapp.net)
    pushName: string;       // Contact display name
    content: string;
    type: "TEXT" | "IMAGE" | "AUDIO" | "VIDEO" | "DOCUMENT" | "PTT";
    mediaUrl?: string;
    mediaBase64?: string;   // Base64-encoded media data (audio, image, etc.)
    mediaMimetype?: string; // MIME type of the media (e.g., audio/ogg; codecs=opus)

    // Metadata
    timestamp: string;
    externalId: string;
    isNewContact?: boolean;
}

export class N8nService {

    /**
     * Forward a single message to the bot's configured n8n webhook.
     * Returns true if forwarded successfully, false otherwise.
     */
    static async forward(payload: N8nWebhookPayload): Promise<boolean> {
        // 1. Get the bot's webhook URL
        const bot = await prisma.bot.findUnique({
            where: { id: payload.botId },
            select: { webhookUrl: true, name: true }
        });

        if (!bot?.webhookUrl) {
            console.warn(`[n8n] Bot ${payload.botId} has no webhook URL configured, skipping forward`);
            return false;
        }

        const success = await this.postToWebhook(bot.webhookUrl, payload, payload.messageId);

        if (success) {
            await prisma.message.update({
                where: { id: payload.messageId },
                data: { forwardedAt: new Date(), isProcessed: true }
            });
        }

        return success;
    }

    /**
     * Forward a batch of messages to the bot's configured n8n webhook.
     * Returns true if forwarded successfully, false otherwise.
     */
    static async forwardBatch(payload: BatchPayload): Promise<boolean> {
        const bot = await prisma.bot.findUnique({
            where: { id: payload.botId },
            select: { webhookUrl: true, name: true }
        });

        if (!bot?.webhookUrl) {
            console.warn(`[n8n] Bot ${payload.botId} has no webhook URL configured, skipping batch forward`);
            return false;
        }

        console.log(`[n8n] Forwarding batch of ${payload.messageCount} messages for ${payload.from}`);
        return this.postToWebhook(bot.webhookUrl, payload, `batch:${payload.from}`);
    }

    /**
     * POST payload to a webhook URL with retry logic.
     */
    private static async postToWebhook(webhookUrl: string, payload: any, logId: string): Promise<boolean> {
        const maxRetries = 3;
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(webhookUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(10000) // 10s timeout
                });

                if (response.ok) {
                    console.log(`[n8n] ${logId} forwarded to n8n (attempt ${attempt})`);
                    return true;
                }

                // Non-retryable HTTP errors (4xx)
                if (response.status >= 400 && response.status < 500) {
                    const body = await response.text().catch(() => "");
                    console.error(`[n8n] Webhook returned ${response.status}: ${body.substring(0, 200)}`);
                    return false;
                }

                // Server error, retry
                lastError = new Error(`HTTP ${response.status}`);
                console.warn(`[n8n] Webhook returned ${response.status}, retrying (${attempt}/${maxRetries})...`);

            } catch (error: any) {
                lastError = error;
                console.warn(`[n8n] Forward attempt ${attempt}/${maxRetries} failed:`, error.message);
            }

            // Exponential backoff: 1s, 2s, 4s
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
            }
        }

        console.error(`[n8n] Failed to forward ${logId} after ${maxRetries} attempts:`, lastError?.message);
        return false;
    }
}

