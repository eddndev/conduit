import { Worker, Job } from "bullmq";
import { QUEUE_NAME } from "../services/queue.service";
import { N8nService, type N8nWebhookPayload } from "../services/n8n.service";
import type { BatchPayload } from "../services/batcher.service";

const REDIS_URL = process.env['REDIS_URL'] || "redis://localhost:6379";

export const startConduitWorker = () => {
    console.log(`[Worker] Starting Conduit Worker on queue: ${QUEUE_NAME}`);

    const worker = new Worker(
        QUEUE_NAME,
        async (job: Job) => {
            switch (job.name) {
                case "forward_to_n8n":
                    const payload = job.data as N8nWebhookPayload;
                    const success = await N8nService.forward(payload);
                    if (!success) {
                        throw new Error(`Failed to forward message ${payload.messageId} to n8n`);
                    }
                    break;

                case "forward_to_n8n_batch":
                    const batchPayload = job.data as BatchPayload;
                    const batchSuccess = await N8nService.forwardBatch(batchPayload);
                    if (!batchSuccess) {
                        throw new Error(`Failed to forward batch (${batchPayload.messageCount} msgs) for ${batchPayload.from}`);
                    }
                    break;

                default:
                    console.warn(`[Worker] Unknown job name: ${job.name}`);
            }
            return { processed: true };
        },
        {
            connection: {
                url: REDIS_URL
            },
            concurrency: 20
        }
    );

    worker.on("completed", (job) => {
        // Silently complete
    });

    worker.on("failed", (job, err) => {
        console.error(`[Queue] Job ${job?.id} failed:`, err.message);
    });

    return worker;
};

