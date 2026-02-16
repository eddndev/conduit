
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    type WASocket,
    type WAMessage,
    jidNormalizedUser
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as fs from 'fs';
import * as path from 'path';
import QRCode from 'qrcode';
import { prisma } from './postgres.service';
import { queueService } from './queue.service';
import { MessageBatcher } from './batcher.service';
import { SessionStatus } from '@prisma/client';
import pino from 'pino';

const logger = pino({ level: 'silent' });

// Map to store active sockets: botId -> socket
const sessions = new Map<string, WASocket>();
// Map to store current QR codes: botId -> qrDataURL
const qrCodes = new Map<string, string>();

const AUTH_DIR = 'auth_info_baileys';

// Label tracking per bot
const botLabels = new Map<string, Map<string, string>>();       // botId -> (labelId -> labelName)
const chatLabels = new Map<string, Map<string, Set<string>>>(); // botId -> (chatJid -> Set<labelId>)

export class BaileysService {

    static async startSession(botId: string) {
        if (sessions.has(botId)) {
            return sessions.get(botId);
        }

        console.log(`[${new Date().toISOString()}] [Baileys] Starting session for Bot ${botId}`);

        const sessionDir = path.join(AUTH_DIR, botId);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version, isLatest } = await fetchLatestBaileysVersion();

        console.log(`[${new Date().toISOString()}] [Baileys] Using WA v${version.join('.')}, isLatest: ${isLatest}`);

        try {
            // @ts-ignore
            const sock = makeWASocket({
                version,
                logger,
                printQRInTerminal: false,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                generateHighQualityLinkPreview: true,
                qrTimeout: 60000,
            });

            sessions.set(botId, sock);

            sock.ev.on('creds.update', saveCreds);

            // Track labels for IGNORAR filtering
            botLabels.set(botId, new Map());
            chatLabels.set(botId, new Map());

            sock.ev.on('labels.edit', (label) => {
                console.log(`[Baileys] [Labels] label.edit for Bot ${botId}:`, JSON.stringify(label));
                const labels = botLabels.get(botId)!;
                if (label.deleted) {
                    labels.delete(label.id);
                } else {
                    labels.set(label.id, label.name);
                }
            });

            sock.ev.on('labels.association', ({ association, type }) => {
                console.log(`[Baileys] [Labels] label.association for Bot ${botId}:`, JSON.stringify({ association, type }));
                if (association.type !== 'label_jid') return;
                const chats = chatLabels.get(botId)!;
                const chatId = jidNormalizedUser(association.chatId);
                if (type === 'add') {
                    if (!chats.has(chatId)) chats.set(chatId, new Set());
                    chats.get(chatId)!.add(association.labelId);
                } else {
                    chats.get(chatId)?.delete(association.labelId);
                }
            });

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    console.log(`[${new Date().toISOString()}] [Baileys] QR Received for Bot ${botId}`);
                    try {
                        const url = await QRCode.toDataURL(qr);
                        qrCodes.set(botId, url);
                    } catch (err) {
                        console.error(`[${new Date().toISOString()}] QR Generation Error`, err);
                    }
                }

                if (connection === 'close') {
                    const error = lastDisconnect?.error as Boom;
                    const statusCode = error?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 408;

                    console.log(`[Baileys] Connection closed for Bot ${botId}. Code: ${statusCode}, Reconnecting: ${shouldReconnect}`, error);

                    sessions.delete(botId);
                    qrCodes.delete(botId);

                    if (shouldReconnect) {
                        setTimeout(() => this.startSession(botId), 5000);
                    } else {
                        console.log(`[Baileys] Bot ${botId} stopped (Logged out or QR timeout).`);
                    }
                } else if (connection === 'open') {
                    console.log(`[Baileys] Connection opened for Bot ${botId}`);
                    qrCodes.delete(botId);
                }
            });

            sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type !== 'notify') return;

                for (const msg of messages) {
                    if (!msg.message) continue;
                    if (msg.key.remoteJid === 'status@broadcast') continue;
                    if (msg.key.fromMe) continue; // Skip own messages — prevents n8n loops when human replies

                    // @ts-ignore
                    await this.handleIncomingMessage(botId, msg);
                }
            });

            return sock;

        } catch (error: any) {
            console.error(`[${new Date().toISOString()}] [Baileys] Failed to start session for bot ${botId}:`, error);
            if (error.message?.includes('QR refs attempts ended')) {
                console.log(`[${new Date().toISOString()}] [Baileys] QR timeout for bot ${botId}. Removing session to allow fresh retry.`);
                this.stopSession(botId);
            }
            return null;
        }
    }

    /**
     * Handle incoming WhatsApp message:
     * 1. Normalize JID
     * 2. Resolve/create session
     * 3. Persist message (with deduplication)
     * 4. Enqueue for n8n forwarding
     */
    private static async handleIncomingMessage(botId: string, msg: WAMessage & { message: any }) {
        const rawFrom = msg.key.remoteJid;
        if (!rawFrom) return;

        // Normalize JID
        let from = jidNormalizedUser(rawFrom);

        if (from.includes('@lid') && (msg.key as any).remoteJidAlt) {
            from = jidNormalizedUser((msg.key as any).remoteJidAlt);
        }

        // Check if chat is labeled IGNORAR
        if (this.isChatIgnored(botId, from)) {
            console.log(`[Baileys] Ignoring message from ${from} — labeled IGNORAR`);
            return;
        }

        // Extract content
        let content = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            "";

        const msgType = msg.message.imageMessage ? 'IMAGE' :
            msg.message.audioMessage ? 'AUDIO' :
                msg.message.pttMessage ? 'PTT' :
                    msg.message.videoMessage ? 'VIDEO' :
                        msg.message.documentMessage ? 'DOCUMENT' : 'TEXT';

        // Download audio/PTT media and transcribe with Whisper
        let mediaBase64: string | undefined;
        let mediaMimetype: string | undefined;

        if (msgType === 'AUDIO' || msgType === 'PTT') {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}) as Buffer;
                mediaBase64 = buffer.toString('base64');
                mediaMimetype = msg.message.audioMessage?.mimetype ||
                    msg.message.pttMessage?.mimetype ||
                    'audio/ogg; codecs=opus';
                console.log(`[Baileys] Downloaded ${msgType} (${Math.round(buffer.length / 1024)}KB) from ${from}`);

                // Transcribe with Whisper if API key is available
                const openaiKey = process.env['OPENAI_API_KEY'];
                if (openaiKey) {
                    try {
                        const formData = new FormData();
                        formData.append('file', new Blob([buffer], { type: mediaMimetype }), 'audio.ogg');
                        formData.append('model', 'whisper-1');

                        const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${openaiKey}` },
                            body: formData,
                            signal: AbortSignal.timeout(30000)
                        });

                        if (whisperRes.ok) {
                            const { text } = await whisperRes.json() as { text: string };
                            content = `[🎤 Audio transcription]: ${text}`;
                            console.log(`[Baileys] Whisper transcription from ${from}: ${text.substring(0, 80)}...`);
                        } else {
                            console.error(`[Baileys] Whisper API returned ${whisperRes.status}`);
                        }
                    } catch (whisperErr: any) {
                        console.error(`[Baileys] Whisper transcription failed:`, whisperErr.message);
                    }
                }
            } catch (dlErr: any) {
                console.error(`[Baileys] Failed to download audio from ${from}:`, dlErr.message);
            }
        }

        console.log(`[${new Date().toISOString()}] [Baileys] Received ${msgType} from ${from} (${msg.pushName}) [MsgID: ${msg.key.id}] on Bot ${botId}: ${content.substring(0, 50)}...`);

        try {
            // 1. Resolve Bot
            const bot = await prisma.bot.findUnique({ where: { id: botId } });
            if (!bot) return;

            // 1.5 Check if this contact is already handed off to a human
            const existingClient = await prisma.client.findUnique({
                where: { botId_jid: { botId: bot.id, jid: from } }
            });
            if (existingClient && (existingClient.status === 'READY' || existingClient.status === 'ATTENDED')) {
                console.log(`[Baileys] Skipping ${from} — already ${existingClient.status}, handled by human`);
                return;
            }

            // 2. Resolve Session
            let isNewContact = false;
            let session = await prisma.session.findUnique({
                where: {
                    botId_identifier: {
                        botId: bot.id,
                        identifier: from
                    }
                }
            });

            if (!session) {
                isNewContact = true;
                console.log(`[Baileys] New Session for user ${from} on bot ${bot.name}`);
                try {
                    session = await prisma.session.create({
                        data: {
                            botId: bot.id,
                            identifier: from,
                            name: msg.pushName || `User ${from.slice(0, 6)}`,
                            status: SessionStatus.CONNECTED
                        }
                    });
                } catch (e: any) {
                    if (e.code === 'P2002') {
                        console.log(`[Baileys] Session race condition detected for ${from}, fetching existing...`);
                        const existing = await prisma.session.findUnique({
                            where: {
                                botId_identifier: { botId: bot.id, identifier: from }
                            }
                        });
                        if (!existing) throw e;
                        session = existing;
                    } else {
                        throw e;
                    }
                }
            }

            // 3. Persist Message (with deduplication)
            let message;
            try {
                const messageExternalId = msg.key.id || `msg_${Date.now()}`;
                const existingMessage = await prisma.message.findUnique({
                    where: { externalId: messageExternalId }
                });

                if (existingMessage) {
                    console.log(`[Baileys] Message ${messageExternalId} already exists, skipping.`);
                    message = existingMessage;
                } else {
                    message = await prisma.message.create({
                        data: {
                            externalId: messageExternalId,
                            sessionId: session.id,
                            sender: from,
                            fromMe: msg.key.fromMe || false,
                            content,
                            type: msgType,
                            isProcessed: false
                        }
                    });
                }
            } catch (e: any) {
                if (e.code === 'P2002') {
                    console.warn(`[Baileys] Message creation collision for ${msg.key.id}, fetching existing...`);
                    message = await prisma.message.findUnique({
                        where: { externalId: msg.key.id! }
                    });
                } else {
                    throw e;
                }
            }

            if (!message) return;

            // 4. Enqueue for n8n forwarding (with optional batching)
            if (!message.forwardedAt) {
                const n8nPayload = {
                    botId: bot.id,
                    botName: bot.name,
                    apiKey: bot.apiKey || "",
                    sessionId: session.id,
                    messageId: message.id,
                    from,
                    pushName: msg.pushName || "",
                    content,
                    type: msgType as any,
                    timestamp: new Date().toISOString(),
                    externalId: message.externalId,
                    mediaBase64,
                    mediaMimetype,
                    isNewContact,
                };

                if (bot.responseDelay && bot.responseDelay > 0) {
                    // Batch: buffer and forward after delay
                    await MessageBatcher.add(n8nPayload, bot.responseDelay);
                } else {
                    // Instant: forward immediately
                    await queueService.enqueueForN8n(n8nPayload);
                }
            }

        } catch (e) {
            console.error(`[${new Date().toISOString()}] [Baileys] Error processing message:`, e);
        }
    }

    static getQR(botId: string) {
        return qrCodes.get(botId);
    }

    static getSession(botId: string) {
        return sessions.get(botId);
    }

    private static isChatIgnored(botId: string, chatJid: string): boolean {
        const labels = botLabels.get(botId);
        const chats = chatLabels.get(botId);
        if (!labels || !chats) return false;

        const labelIds = chats.get(chatJid);
        if (!labelIds) return false;

        for (const labelId of labelIds) {
            if (labels.get(labelId)?.toUpperCase() === 'IGNORAR') return true;
        }
        return false;
    }

    static async stopSession(botId: string) {
        const sock = sessions.get(botId);
        if (sock) {
            try {
                await sock.logout();
            } catch (e) {
                console.log(`[${new Date().toISOString()}] [Baileys] Error during logout for bot ${botId}:`, e);
            }
            sessions.delete(botId);
        }
        qrCodes.delete(botId);
        botLabels.delete(botId);
        chatLabels.delete(botId);

        const sessionDir = path.join(AUTH_DIR, botId);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            console.log(`[${new Date().toISOString()}] [Baileys] Cleared auth data for bot ${botId}`);
        }

        console.log(`[${new Date().toISOString()}] [Baileys] Session stopped for bot ${botId}`);
    }

    static async sendMessage(botId: string, to: string, content: any): Promise<boolean> {
        const sock = sessions.get(botId);
        if (!sock) {
            console.warn(`[${new Date().toISOString()}] [Baileys] sendMessage failed: Bot ${botId} not connected`);
            return false;
        }

        try {
            await sock.sendMessage(to, content);
            return true;
        } catch (error: any) {
            const errorCode = error?.code || 'UNKNOWN';
            const errorMsg = error?.message || String(error);
            console.error(`[${new Date().toISOString()}] [Baileys] sendMessage failed for Bot ${botId} to ${to}:`, {
                code: errorCode,
                message: errorMsg,
                contentType: content?.text ? 'TEXT' : content?.image ? 'IMAGE' : content?.audio ? 'AUDIO' : 'OTHER'
            });

            throw new Error(`Baileys send failed (${errorCode}): ${errorMsg}`);
        }
    }
}
