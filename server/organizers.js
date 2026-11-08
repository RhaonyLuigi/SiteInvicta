import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { member, stock } from "./commerce.js";
import { requireValue, token, hash } from "./security.js";
import { notify, job } from "./notifications.js";

const uuid = z.uuid();
const eventSchema = z.object({
    name: z.string().trim().min(3).max(120),
    description: z.string().trim().max(4000),
    place: z.string().trim().min(3).max(240),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    capacity: z.number().int().min(1).max(1000000),
    coverUrl: z.string().max(2000).refine((value) => value.startsWith("/assets/") || /^https:\/\//.test(value)),
    refundPolicy: z.string().trim().min(10).max(2000)
}).refine((value) => new Date(value.endsAt) > new Date(value.startsAt), { message: "O encerramento precisa ser posterior ao início." });

const lotSchema = z.object({
    name: z.string().trim().min(2).max(80),
    category: z.string().trim().min(2).max(80),
    description: z.string().trim().max(1000),
    priceCents: z.number().int().min(0).max(10000000),
    capacity: z.number().int().min(1).max(1000000),
    salesStart: z.iso.datetime({ offset: true }),
    salesEnd: z.iso.datetime({ offset: true }),
    closed: z.boolean().default(false)
}).refine((value) => new Date(value.salesEnd) > new Date(value.salesStart), { message: "Confira o período de venda." });

function slug(name) {
    return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) + "-" + randomUUID().slice(0, 8);
}

export function organizerRouter(db, config, store) {
    const router = Router();
    async function managedEvent(userId, id, roles) {
        const { rows: [event] } = await db.query("SELECT * FROM events WHERE id=$1", [uuid.parse(id)]);
        requireValue(event, 404, "Evento não encontrado.");
        await member(db, userId, event.org_id, roles);
        return event;
    }
    router.get("/", async (req, res) => {
        const { rows: organizations } = await db.query(
            "SELECT o.id,o.name,o.fee_bps,o.fee_mode,o.stripe_account_id,o.stripe_ready,m.role FROM organizations o JOIN members m ON m.org_id=o.id WHERE m.user_id=$1 ORDER BY o.created_at",
            [req.user.id]
        );
        const { rows: events } = await db.query(
            "SELECT e.*,m.role FROM events e JOIN members m ON m.org_id=e.org_id WHERE m.user_id=$1 ORDER BY e.starts_at DESC", [req.user.id]
        );
        const { rows: lots } = await db.query("SELECT l.* FROM lots l JOIN events e ON e.id=l.event_id JOIN members m ON m.org_id=e.org_id WHERE m.user_id=$1", [req.user.id]);
        res.json({ organizations, events, lots, paymentProvider: config.paymentProvider });
    });
    router.post("/organizations", async (req, res) => {
        const { name } = z.object({ name: z.string().trim().min(3).max(100) }).parse(req.body);
        const org = await db.transaction(async (client) => {
            const { rows: [item] } = await client.query("INSERT INTO organizations(name,fee_bps,fee_mode) VALUES($1,$2,$3) RETURNING id,name", [name, config.feeBps, config.feeMode]);
            await client.query("INSERT INTO members(org_id,user_id,role) VALUES($1,$2,'owner')", [item.id, req.user.id]);
            return item;
        });
        res.status(201).json(org);
    });
    router.get("/organizations/:id", async (req, res) => {
        const id = uuid.parse(req.params.id);
        await member(db, req.user.id, id);
        const { rows: [summary] } = await db.query(`
            SELECT count(o.id) FILTER(WHERE o.status='paid')::int AS paid_orders,
                COALESCE(sum(o.quantity) FILTER(WHERE o.status='paid'),0)::int AS tickets,
                COALESCE(sum(o.total_cents) FILTER(WHERE o.status='paid'),0)::bigint AS gross_cents,
                COALESCE(sum(o.fee_cents) FILTER(WHERE o.status='paid'),0)::bigint AS platform_cents,
                COALESCE(sum(p.provider_fee_cents) FILTER(WHERE o.status='paid'),0)::bigint AS provider_cents
            FROM orders o JOIN events e ON e.id=o.event_id LEFT JOIN payments p ON p.provider_id=o.paid_payment_id WHERE e.org_id=$1`, [id]);
        const { rows: team } = await db.query("SELECT u.id,u.name,u.email,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1", [id]);
        const { rows: refunds } = await db.query(`
            SELECT r.*,o.total_cents,e.name AS event_name,u.name AS buyer FROM refund_requests r
            JOIN orders o ON o.id=r.order_id JOIN events e ON e.id=o.event_id JOIN users u ON u.id=o.user_id
            WHERE e.org_id=$1 ORDER BY r.created_at DESC LIMIT 200`, [id]);
        const { rows: failures } = await db.query(`
            SELECT o.id,o.status,e.name FROM orders o JOIN events e ON e.id=o.event_id
            WHERE e.org_id=$1 AND o.status='refund_pending' ORDER BY o.created_at DESC LIMIT 100`, [id]);
        res.json({ summary, team, refunds, pendingRefunds: failures });
    });
    router.post("/organizations/:id/invitations", async (req, res) => {
        const id = uuid.parse(req.params.id);
        await member(db, req.user.id, id, ["owner"]);
        const input = z.object({ email: z.email().max(254).transform((value) => value.toLowerCase()), role: z.enum(["manager", "checkin"]) }).parse(req.body);
        const secret = token();
        await db.transaction(async (client) => {
            await client.query("INSERT INTO invitations(token_hash,org_id,email,role,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days')", [hash(secret), id, input.email, input.role]);
            await job(client, "email", "invite:" + hash(secret), { email: input.email, subject: "Convite para organizar eventos na Invicta",
                text: "Entre com este e-mail e aceite o convite.\n\n" + config.url + "/conta.html#convite=" + secret });
        });
        res.status(201).json({ message: "Convite enviado por e-mail." });
    });
    router.delete("/organizations/:org/members/:user", async (req, res) => {
        const org = uuid.parse(req.params.org);
        await member(db, req.user.id, org, ["owner"]);
        await db.query("DELETE FROM members WHERE org_id=$1 AND user_id=$2 AND role<>'owner'", [org, uuid.parse(req.params.user)]);
        res.json({ ok: true });
    });
    router.post("/invitations/accept", async (req, res) => {
        const input = z.object({ token: z.string().min(30).max(200) }).parse(req.body);
        await db.transaction(async (client) => {
            const { rows: [invitation] } = await client.query("UPDATE invitations SET used_at=now() WHERE token_hash=$1 AND email=$2 AND expires_at>now() AND used_at IS NULL RETURNING *",
                [hash(input.token), req.user.email]);
            requireValue(invitation, 400, "Convite expirado, utilizado ou destinado a outro e-mail.");
            await client.query("INSERT INTO members(org_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(org_id,user_id) DO NOTHING", [invitation.org_id, req.user.id, invitation.role]);
        });
        res.json({ ok: true });
    });
    router.post("/organizations/:id/events", async (req, res) => {
        const orgId = uuid.parse(req.params.id);
        await member(db, req.user.id, orgId);
        const input = eventSchema.parse(req.body);
        const { rows: [event] } = await db.query(`
            INSERT INTO events(org_id,slug,name,description,place,starts_at,ends_at,capacity,cover_url,refund_policy)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [orgId, slug(input.name), input.name, input.description, input.place, input.startsAt, input.endsAt, input.capacity, input.coverUrl, input.refundPolicy]);
        res.status(201).json(event);
    });
    router.put("/events/:id", async (req, res) => {
        const event = await managedEvent(req.user.id, req.params.id);
        const input = eventSchema.parse(req.body);
        await db.transaction(async (client) => {
            await client.query("SELECT id FROM events WHERE id=$1 FOR UPDATE", [event.id]);
            const counts = await stock(client, event.id, null);
            requireValue(input.capacity >= counts.event_used, 409, "A capacidade deve comportar os ingressos vendidos e reservados.");
            await client.query(`UPDATE events SET name=$2,description=$3,place=$4,starts_at=$5,ends_at=$6,
                capacity=$7,cover_url=$8,refund_policy=$9,updated_at=now() WHERE id=$1`,
            [event.id, input.name, input.description, input.place, input.startsAt, input.endsAt, input.capacity, input.coverUrl, input.refundPolicy]);
            if (event.status !== "draft") {
                const { rows } = await client.query("SELECT DISTINCT user_id FROM orders WHERE event_id=$1 AND status='paid'", [event.id]);
                for (const buyer of rows) await notify(client, buyer.user_id, "updated:" + event.id + ":" + randomUUID(), "Evento atualizado",
                    input.name + " teve informações atualizadas. Confira a data e o local.", "/index.html?evento=" + event.slug);
            }
        });
        res.json({ ok: true });
    });
    router.get("/events/:id/lots", async (req, res) => {
        const event = await managedEvent(req.user.id, req.params.id, ["owner", "manager", "checkin"]);
        const { rows } = await db.query("SELECT * FROM lots WHERE event_id=$1 ORDER BY sales_start", [event.id]);
        res.json(rows);
    });
    router.post("/events/:id/lots", async (req, res) => {
        const event = await managedEvent(req.user.id, req.params.id);
        const input = lotSchema.parse(req.body);
        const { rows: [lot] } = await db.query(`
            INSERT INTO lots(event_id,name,category,description,price_cents,capacity,sales_start,sales_end,closed)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [event.id, input.name, input.category, input.description, input.priceCents, input.capacity, input.salesStart, input.salesEnd, input.closed]);
        res.status(201).json(lot);
    });
    router.put("/lots/:id", async (req, res) => {
        const { rows: [lot] } = await db.query("SELECT * FROM lots WHERE id=$1", [uuid.parse(req.params.id)]);
        requireValue(lot, 404, "Lote não encontrado.");
        const event = await managedEvent(req.user.id, lot.event_id);
        const input = lotSchema.parse(req.body);
        await db.transaction(async (client) => {
            await client.query("SELECT id FROM events WHERE id=$1 FOR UPDATE", [event.id]);
            const counts = await stock(client, event.id, lot.id);
            requireValue(input.capacity >= counts.lot_used, 409, "A capacidade do lote deve comportar suas vendas e reservas.");
            await client.query(`UPDATE lots SET name=$2,category=$3,description=$4,price_cents=$5,capacity=$6,
                sales_start=$7,sales_end=$8,closed=$9 WHERE id=$1`,
            [lot.id, input.name, input.category, input.description, input.priceCents, input.capacity, input.salesStart, input.salesEnd, input.closed]);
        });
        res.json({ ok: true });
    });
    router.post("/events/:id/status", async (req, res) => {
        const event = await managedEvent(req.user.id, req.params.id);
        const { status } = z.object({ status: z.enum(["published", "closed", "cancelled"]) }).parse(req.body);
        await db.transaction(async (client) => {
            const { rows: [current] } = await client.query("SELECT * FROM events WHERE id=$1 FOR UPDATE", [event.id]);
            requireValue(current.status !== "cancelled", 409, "Um evento cancelado permanece cancelado.");
            if (status === "published") {
                const { rows: lots } = await client.query("SELECT price_cents FROM lots WHERE event_id=$1", [event.id]);
                requireValue(lots.length && new Date(current.ends_at) > new Date(), 409, "Cadastre um lote e confira as datas antes de publicar.");
                const { rows: [org] } = await client.query("SELECT * FROM organizations WHERE id=$1", [event.org_id]);
                if (lots.some((lot) => lot.price_cents > 0)) {
                    requireValue((org.fee_bps ?? config.feeBps) !== null, 409, "Defina a comissão da plataforma antes de publicar vendas.");
                    requireValue(config.paymentProvider === "mock" || org.stripe_ready, 409, "Conecte a conta de recebimento antes de publicar.");
                }
            }
            await client.query("UPDATE events SET status=$2,updated_at=now() WHERE id=$1", [event.id, status]);
            if (status === "cancelled") {
                await client.query("UPDATE orders SET status='cancelled' WHERE event_id=$1 AND status='pending'", [event.id]);
                const { rows: orders } = await client.query("SELECT * FROM orders WHERE event_id=$1 AND status='paid' FOR UPDATE", [event.id]);
                for (const order of orders) await store.requestRefund(client, order, event.org_id, "O evento " + event.name + " foi cancelado. O reembolso está em processamento.");
            }
            await client.query("INSERT INTO audit_logs(org_id,actor_id,action,entity_id) VALUES($1,$2,$3,$4)", [event.org_id, req.user.id, "event:" + status, event.id]);
        });
        res.json({ ok: true });
    });
    router.post("/events/:id/announcement", async (req, res) => {
        const event = await managedEvent(req.user.id, req.params.id);
        const input = z.object({ title: z.string().trim().min(3).max(100), body: z.string().trim().min(5).max(1000), key: z.uuid() }).parse(req.body);
        const { rows: buyers } = await db.query("SELECT DISTINCT user_id FROM orders WHERE event_id=$1 AND status='paid'", [event.id]);
        await db.transaction(async (client) => {
            const key = "announcement:" + event.org_id + ":" + Math.floor(Date.now() / 3600000);
            const { rows: [rate] } = await client.query("INSERT INTO rate_limits(key,expires_at) VALUES($1,now()+interval '2 hours') ON CONFLICT(key) DO UPDATE SET hits=rate_limits.hits+1 RETURNING hits", [key]);
            requireValue(rate.hits <= 10, 429, "O limite é de 10 avisos por organização a cada hora.");
            for (const buyer of buyers) await notify(client, buyer.user_id, "announcement:" + input.key + ":" + buyer.user_id,
                input.title, input.body, "/index.html?evento=" + event.slug);
        });
        res.json({ recipients: buyers.length });
    });
    router.post("/refunds/:id", async (req, res) => {
        const input = z.object({ approve: z.boolean(), reason: z.string().trim().min(5).max(500) }).parse(req.body);
        const { rows: [request] } = await db.query("SELECT r.*,o.event_id FROM refund_requests r JOIN orders o ON o.id=r.order_id WHERE r.id=$1", [uuid.parse(req.params.id)]);
        requireValue(request, 404, "Solicitação não encontrada.");
        const event = await managedEvent(req.user.id, request.event_id);
        await db.transaction(async (client) => {
            await client.query("SELECT id FROM events WHERE id=$1 FOR UPDATE", [event.id]);
            const { rows: [order] } = await client.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [request.order_id]);
            const { rows: [updated] } = await client.query("UPDATE refund_requests SET status=$2 WHERE id=$1 AND status='pending' RETURNING id", [request.id, input.approve ? "approved" : "denied"]);
            requireValue(updated, 409, "Solicitação já analisada.");
            if (input.approve) {
                requireValue(order.status === "paid", 409, "Este pedido não permite um novo reembolso.");
                await store.requestRefund(client, order, event.org_id, input.reason);
            } else await notify(client, order.user_id, "refund-denied:" + request.id, "Solicitação de reembolso analisada", input.reason);
        });
        res.json({ ok: true });
    });
    router.get("/events/:id/participants.csv", async (req, res) => {
        const event = await managedEvent(req.user.id, req.params.id);
        const { rows } = await db.query(`SELECT u.name,u.email,l.category,o.status,t.checked_at FROM tickets t
            JOIN orders o ON o.id=t.order_id JOIN users u ON u.id=o.user_id JOIN lots l ON l.id=o.lot_id
            WHERE o.event_id=$1 ORDER BY u.name`, [event.id]);
        const cell = (value) => {
            let text = String(value ?? "");
            if (/^[=+@\-\s]/.test(text)) text = "'" + text;
            return '"' + text.replaceAll('"', '""') + '"';
        };
        const csv = [["Nome", "E-mail", "Categoria", "Pedido", "Entrada"], ...rows.map((row) => [row.name, row.email, row.category, row.status, row.checked_at])];
        res.type("text/csv").set("Content-Disposition", 'attachment; filename="participantes.csv"').send("\uFEFF" + csv.map((row) => row.map(cell).join(";")).join("\r\n"));
    });
    return router;
}
