import { Elysia, t } from "elysia";
import { prisma } from "../services/postgres.service";

export const clientController = new Elysia({ prefix: "/clients" })
    // Create or update a client (called by n8n tool)
    .post("/", async ({ body, set }) => {
        try {
            const client = await prisma.client.upsert({
                where: {
                    botId_jid: {
                        botId: body.botId,
                        jid: body.jid,
                    },
                },
                update: {
                    name: body.name ?? undefined,
                    curp: body.curp ?? undefined,
                    phone: body.phone ?? undefined,
                    email: body.email ?? undefined,
                    status: body.status ?? undefined,
                },
                create: {
                    botId: body.botId,
                    jid: body.jid,
                    name: body.name,
                    curp: body.curp,
                    phone: body.phone,
                    email: body.email,
                    status: body.status || "PENDING",
                },
            });

            return { success: true, client };
        } catch (e: any) {
            console.error("[Clients] Create error:", e.message);
            set.status = 500;
            return { error: e.message };
        }
    }, {
        body: t.Object({
            botId: t.String(),
            jid: t.String(),
            name: t.Optional(t.String()),
            curp: t.Optional(t.String()),
            phone: t.Optional(t.String()),
            email: t.Optional(t.String()),
            status: t.Optional(t.String()),
        }),
    })
    // List clients (optionally filtered by botId and/or status)
    .get("/", async ({ query }) => {
        const where: any = {};
        if (query.botId) where.botId = query.botId;
        if (query.status) where.status = query.status;

        const clients = await prisma.client.findMany({
            where,
            include: { bot: { select: { name: true } } },
            orderBy: { createdAt: "desc" },
        });

        return { clients };
    }, {
        query: t.Object({
            botId: t.Optional(t.String()),
            status: t.Optional(t.String()),
        }),
    })
    // Update client status
    .patch("/:id", async ({ params: { id }, body, set }) => {
        try {
            const client = await prisma.client.update({
                where: { id },
                data: {
                    status: body.status ?? undefined,
                    curp: body.curp ?? undefined,
                    phone: body.phone ?? undefined,
                    email: body.email ?? undefined,
                    name: body.name ?? undefined,
                },
            });
            return { success: true, client };
        } catch (e: any) {
            set.status = 404;
            return { error: "Client not found" };
        }
    }, {
        body: t.Object({
            status: t.Optional(t.String()),
            curp: t.Optional(t.String()),
            phone: t.Optional(t.String()),
            email: t.Optional(t.String()),
            name: t.Optional(t.String()),
        }),
    })
    // Delete client
    .delete("/:id", async ({ params: { id }, set }) => {
        try {
            await prisma.client.delete({ where: { id } });
            return { success: true };
        } catch (e: any) {
            set.status = 404;
            return { error: "Client not found" };
        }
    });
