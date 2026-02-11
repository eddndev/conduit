import { prisma } from "./postgres.service";

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

    // Session context
    sessionId: string;

    // Message data
    messageId: string;
    from: string;           // JID of the sender (e.g., 521234567890@s.whatsapp.net)
    pushName: string;       // Contact display name
    content: string;
    type: "TEXT" | "IMAGE" | "AUDIO" | "VIDEO" | "DOCUMENT";
    mediaUrl?: string;

    // Metadata
    timestamp: string;
    externalId: string;
}

export class N8nService {

    /**
     * Forward a message to the bot's configured n8n webhook.
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

        // 2. POST to n8n webhook with retry
        const maxRetries = 3;
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(bot.webhookUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(10000) // 10s timeout
                });

                if (response.ok) {
                    console.log(`[n8n] Message ${payload.messageId} forwarded to n8n (attempt ${attempt})`);

                    // 3. Mark message as forwarded
                    await prisma.message.update({
                        where: { id: payload.messageId },
                        data: { forwardedAt: new Date(), isProcessed: true }
                    });

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

        console.error(`[n8n] Failed to forward message ${payload.messageId} after ${maxRetries} attempts:`, lastError?.message);
        return false;
    }
}
