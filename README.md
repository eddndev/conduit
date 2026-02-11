# Conduit

**Conduit** is a WhatsApp ↔ n8n gateway that bridges WhatsApp messages to n8n intelligent workflows. It handles WhatsApp session management via [Baileys](https://github.com/WhiskeySockets/Baileys) and provides a clean API for n8n to send messages back.

## How It Works

```
WhatsApp User ──→ Conduit (Baileys) ──→ n8n Webhook
                                         │
WhatsApp User ←── Conduit (POST /send) ←─┘
```

1. **Incoming**: A WhatsApp message arrives via Baileys → Conduit persists it, then forwards it to the bot's configured n8n webhook URL.
2. **Outgoing**: n8n processes the message through its flows and calls `POST /send` on Conduit to reply.

## Tech Stack

*   **Runtime:** [Bun](https://bun.sh)
*   **Web Framework:** [Elysia](https://elysiajs.com)
*   **Message Queue:** [BullMQ](https://bullmq.io) — Reliable message forwarding with retries
*   **Database:** PostgreSQL — Session and message persistence
*   **Cache/Queue Backend:** Redis
*   **WhatsApp:** [Baileys](https://github.com/WhiskeySockets/Baileys) — Direct WA Web connection
*   **Frontend:** Astro (for QR code scanning)

## Prerequisites

*   [Bun](https://bun.sh/)
*   PostgreSQL
*   Redis
*   n8n instance (with a webhook trigger)

## Getting Started

### 1. Install Dependencies

```bash
cd backend
bun install
```

### 2. Configure Environment

Create `backend/.env`:

```env
DATABASE_URL=postgresql://conduit:password@localhost:5432/conduit
REDIS_URL=redis://localhost:6379
PORT=8080
JWT_SECRET=your-secret-here
```

### 3. Setup Database

```bash
cd backend
bunx prisma migrate dev
```

### 4. Run

```bash
# Backend
cd backend
bun dev

# Frontend (for QR scanning)
cd frontend
bun install
bun run dev
```

## API Reference

### Bot Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/bots` | List all bots |
| `POST` | `/bots` | Create a new bot |
| `GET` | `/bots/:id` | Get bot details |
| `PUT` | `/bots/:id` | Update bot |
| `DELETE` | `/bots/:id` | Delete bot |
| `POST` | `/bots/:id/connect` | Start WhatsApp session |
| `GET` | `/bots/:id/qr` | Get QR code for scanning |
| `GET` | `/bots/:id/status` | Check connection status |
| `POST` | `/bots/:id/disconnect` | Stop WhatsApp session |

### n8n Integration

| Method | Endpoint | Description |
|--------|----------|-------------|
| `PUT` | `/bots/:id/webhook` | Set n8n webhook URL |
| `GET` | `/bots/:id/webhook` | Get webhook config |
| `POST` | `/bots/:id/regenerate-key` | Regenerate API key |
| `POST` | `/send` | Send message via WhatsApp (from n8n) |

### Send Message (from n8n)

```bash
curl -X POST http://localhost:8080/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: cdct_your_api_key_here" \
  -d '{
    "botId": "bot-uuid",
    "to": "521234567890",
    "type": "text",
    "content": "Hello from n8n!"
  }'
```

**Supported types:** `text`, `image`, `audio`, `ptt`, `video`, `document`

### n8n Webhook Payload (incoming)

When a WhatsApp message arrives, Conduit POSTs this to your n8n webhook:

```json
{
  "botId": "uuid",
  "botName": "My Bot",
  "sessionId": "uuid",
  "messageId": "uuid",
  "from": "521234567890@s.whatsapp.net",
  "pushName": "John",
  "content": "Hello!",
  "type": "TEXT",
  "timestamp": "2026-02-10T19:00:00.000Z",
  "externalId": "msg_id"
}
```

## License

This project is licensed under the **GNU General Public License v3.0 (GPLv3)**.
