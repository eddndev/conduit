import { Queue } from "bullmq";
import type { N8nWebhookPayload } from "./n8n.service";

export const QUEUE_NAME = "conduit-message-queue";

class QueueService {
    private queue: Queue;

    constructor() {
        this.queue = new Queue(QUEUE_NAME, {
            connection: {
                url: process.env['REDIS_URL'] || "redis://localhost:6379"
            }
        });
    }

    /**
     * Enqueue an incoming message for forwarding to n8n.
     * BullMQ handles retries and persistence.
     */
    async enqueueForN8n(payload: N8nWebhookPayload) {
        return this.queue.add("forward_to_n8n", payload, {
            attempts: 3,
            backoff: {
                type: "exponential",
                delay: 2000
            }
        });
    }

    async close() {
        await this.queue.close();
    }
}

export const queueService = new QueueService();
