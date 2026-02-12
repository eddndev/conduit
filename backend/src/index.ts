import { Elysia } from "elysia";
import { Worker } from "bullmq";
import { Redis } from "ioredis";

// --- Configuration ---
const REDIS_URL = process.env['REDIS_URL'] || "redis://localhost:6379";
const PORT = process.env.PORT || 8081;

// --- Services ---
const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null // Required for BullMQ
});

redis.on("error", (err) => console.error("Redis Client Error", err));
redis.on("connect", () => console.log("Redis Connected"));

// --- Workers ---
import { startConduitWorker } from "./workers/message.worker";
const worker = startConduitWorker();

// --- Global Error Handlers (Prevent Crash) ---
process.on('uncaughtException', (err) => {
    console.error('!!!! Uncaught Exception !!!!', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('!!!! Unhandled Rejection !!!!', reason);
});

// --- Baileys Init ---
import { prisma } from "./services/postgres.service";
import { BaileysService } from "./services/baileys.service";

// Reconnect WhatsApp Sessions
prisma.bot.findMany().then(bots => {
    console.log(`[Init] Found ${bots.length} WhatsApp bots to reconnect...`);
    for (const bot of bots) {
        BaileysService.startSession(bot.id).catch(err => {
            console.error(`[Init] Failed to start session for ${bot.name}:`, err);
        });
    }
});

// --- API ---
import { webhookController } from "./api/webhook.controller";
import { uploadController } from "./api/upload.controller";
import { botController } from "./api/bot.controller";
import { sendController } from "./api/send.controller";
import { authController } from "./api/auth.controller";
import { clientController } from "./api/client.controller";
import { cors } from "@elysiajs/cors";

const app = new Elysia()
    .use(cors({
        origin: [
            'https://conduit.eddn.dev',
            'https://conduit-api.eddn.dev',
            'http://localhost:4321',
            'http://localhost:5173'
        ],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
    }))
    .use(webhookController)
    .use(uploadController)
    .use(botController)
    .use(sendController)
    .use(authController)
    .use(clientController)
    .get("/", () => "Conduit Gateway Active")
    .get("/health", () => ({ status: "ok", timestamp: new Date().toISOString() }))
    .get("/info", () => ({
        service: "Conduit",
        description: "WhatsApp ↔ n8n Gateway",
        version: "1.0.0",
        redis: redis.status
    }))
    .listen({
        port: Number(PORT),
        hostname: '0.0.0.0'
    });

console.log(
    `🔗 Conduit is running at ${app.server?.hostname}:${app.server?.port}`
);
