import { redis } from "./redis.service";
import { queueService } from "./queue.service";
import { prisma } from "./postgres.service";
import type { N8nWebhookPayload } from "./n8n.service";

/**
 * MessageBatcher — Buffers incoming messages per conversation and forwards
 * them as a single batch to n8n after a configurable delay.
 *
 * Uses Redis lists for message storage and in-memory timers for debouncing.
 * When the timer expires, all buffered messages are popped and enqueued
 * as a single batch job in BullMQ.
 */

export interface BatchMessage {
    messageId: string;
    pushName: string;
    content: string;
    type: string;
    timestamp: string;
    externalId: string;
    mediaBase64?: string;
    mediaMimetype?: string;
}

export interface BatchPayload {
    botId: string;
    botName: string;
    apiKey?: string;
    from: string;
    sessionId: string;
    type: "BATCH";
    messageCount: number;
    messages: BatchMessage[];
    timestamp: string;
    isNewContact?: boolean;
}

// In-memory timer map: "botId:jid" -> NodeJS.Timeout
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const REDIS_KEY_PREFIX = "conduit:batch";

function batchKey(botId: string, jid: string): string {
    return `${REDIS_KEY_PREFIX}:${botId}:${jid}`;
}

function metaKey(botId: string, jid: string): string {
    return `${REDIS_KEY_PREFIX}:meta:${botId}:${jid}`;
}

export class MessageBatcher {

    /**
     * Add a message to the batch buffer.
     * Resets the debounce timer for this conversation.
     */
    static async add(payload: N8nWebhookPayload, delaySeconds: number): Promise<void> {
        const key = batchKey(payload.botId, payload.from);
        const timerKey = `${payload.botId}:${payload.from}`;

        // Store the message in a Redis list
        const batchMessage: BatchMessage = {
            messageId: payload.messageId,
            pushName: payload.pushName,
            content: payload.content,
            type: payload.type,
            timestamp: payload.timestamp,
            externalId: payload.externalId,
            mediaBase64: payload.mediaBase64,
            mediaMimetype: payload.mediaMimetype,
        };

        await redis.rpush(key, JSON.stringify(batchMessage));

        // Store metadata (botName, sessionId) — overwrite each time, latest is fine
        await redis.set(metaKey(payload.botId, payload.from), JSON.stringify({
            botName: payload.botName,
            sessionId: payload.sessionId,
            apiKey: payload.apiKey,
            isNewContact: payload.isNewContact,
        }));

        // Set TTL on the Redis key to auto-cleanup if timer somehow fails (delay * 3)
        const ttl = Math.max(delaySeconds * 3, 60);
        await redis.expire(key, ttl);
        await redis.expire(metaKey(payload.botId, payload.from), ttl);

        // Reset the debounce timer
        if (timers.has(timerKey)) {
            clearTimeout(timers.get(timerKey)!);
        }

        const timer = setTimeout(() => {
            timers.delete(timerKey);
            this.flush(payload.botId, payload.from).catch((err) => {
                console.error(`[Batcher] Flush failed for ${timerKey}:`, err.message);
            });
        }, delaySeconds * 1000);

        timers.set(timerKey, timer);

        console.log(`[Batcher] Buffered message for ${payload.from} on bot ${payload.botId} (delay: ${delaySeconds}s)`);
    }

    /**
     * Flush all buffered messages for a conversation and enqueue as a batch.
     */
    static async flush(botId: string, jid: string): Promise<void> {
        const key = batchKey(botId, jid);
        const mKey = metaKey(botId, jid);

        // Pop all messages atomically
        const rawMessages = await redis.lrange(key, 0, -1);
        await redis.del(key);

        if (rawMessages.length === 0) {
            console.warn(`[Batcher] Flush called but no messages for ${botId}:${jid}`);
            return;
        }

        // Get metadata
        const rawMeta = await redis.get(mKey);
        await redis.del(mKey);

        const meta = rawMeta ? JSON.parse(rawMeta) : { botName: "Unknown", sessionId: "", apiKey: "", isNewContact: false };
        const messages: BatchMessage[] = rawMessages.map((raw) => JSON.parse(raw));

        console.log(`[Batcher] Flushing ${messages.length} messages for ${jid} on bot ${botId}`);

        // Enqueue as a single batch job
        const batchPayload: BatchPayload = {
            botId,
            botName: meta.botName,
            apiKey: meta.apiKey,
            from: jid,
            sessionId: meta.sessionId,
            type: "BATCH",
            messageCount: messages.length,
            messages,
            timestamp: new Date().toISOString(),
            isNewContact: meta.isNewContact,
        };

        await queueService.enqueueForN8nBatch(batchPayload);

        // Mark all messages as forwarded
        const messageIds = messages.map((m) => m.messageId);
        await prisma.message.updateMany({
            where: { id: { in: messageIds } },
            data: { forwardedAt: new Date(), isProcessed: true },
        });
    }

    /**
     * Get number of active batch timers (for monitoring).
     */
    static get activeTimers(): number {
        return timers.size;
    }
}
