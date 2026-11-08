import { requireValue, ticketCode, ticketId } from "./security.js";
import { notify, job } from "./notifications.js";

export async function member(db, userId, orgId, roles = ["owner", "manager"]) {
    const { rows: [access] } = await db.query("SELECT role FROM members WHERE org_id=$1 AND user_id=$2", [orgId, userId]);
    requireValue(access && roles.includes(access.role), 403, "Você não tem permissão nesta organização.");
    return access;
}

export async function stock(client, eventId, lotId, exclude = null) {
    const { rows: [counts] } = await client.query(`
        SELECT COALESCE(sum(quantity),0)::int AS event_used,
            COALESCE(sum(quantity) FILTER(WHERE lot_id=$2),0)::int AS lot_used
        FROM orders WHERE event_id=$1 AND ($3::uuid IS NULL OR id<>$3)
        AND (status IN ('paid','refund_pending') OR (status='pending' AND expires_at>now()))`,
    [eventId, lotId, exclude]);
    return counts;
}

export function commerce(db, config) {
    async function createOrder(userId, lotId, quantity, idempotencyKey) {
        const { rows: [initial] } = await db.query("SELECT event_id FROM lots WHERE id=$1", [lotId]);
        requireValue(initial, 404, "Lote não encontrado.");
        return db.transaction(async (client) => {
            const { rows: [event] } = await client.query("SELECT * FROM events WHERE id=$1 FOR UPDATE", [initial.event_id]);
            const { rows: [previous] } = await client.query("SELECT * FROM orders WHERE user_id=$1 AND idempotency_key=$2", [userId, idempotencyKey]);
            if (previous) {
                requireValue(previous.lot_id === lotId && previous.quantity === quantity, 409, "Este identificador já pertence a outro pedido.");
                return previous;
            }
            const { rows: [lot] } = await client.query("SELECT * FROM lots WHERE id=$1 FOR UPDATE", [lotId]);
            requireValue(event.status === "published" && new Date(event.ends_at) > new Date(), 409, "As vendas deste evento estão encerradas.");
            requireValue(!lot.closed && new Date(lot.sales_start) <= new Date() && new Date(lot.sales_end) > new Date(), 409, "Este lote está fora do período de venda.");
            const { rows: [org] } = await client.query("SELECT * FROM organizations WHERE id=$1", [event.org_id]);
            const bps = org.fee_bps ?? config.feeBps;
            if (lot.price_cents > 0) {
                requireValue(bps !== null, 409, "A comissão da plataforma precisa ser definida antes da venda.");
                requireValue(config.paymentProvider === "mock" || (config.paymentProvider === "stripe" ? org.stripe_ready : org.mp_access_token), 409, "O organizador precisa configurar o recebimento.");
            }
            const counts = await stock(client, event.id, lot.id);
            requireValue(quantity <= lot.capacity - counts.lot_used && quantity <= event.capacity - counts.event_used, 409, "A quantidade escolhida ficou indisponível.");
            const subtotal = lot.price_cents * quantity;
            const fee = Math.round(subtotal * (bps || 0) / 10000);
            const total = org.fee_mode === "added" ? subtotal + fee : subtotal;
            const { rows: [order] } = await client.query(`
                INSERT INTO orders(user_id,event_id,lot_id,idempotency_key,quantity,unit_price_cents,
                    subtotal_cents,fee_cents,total_cents,fee_bps,fee_mode,expires_at,payment_provider)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+($12::int * interval '1 minute'),$13) RETURNING *`,
            [userId, event.id, lot.id, idempotencyKey, quantity, lot.price_cents, subtotal, fee, total, bps || 0, org.fee_mode, config.paymentProvider === "stripe" ? 30 : 15, config.paymentProvider]);
            return order;
        });
    }

    async function requestRefund(client, order, orgId, reason) {
        await client.query("UPDATE orders SET status='refund_pending' WHERE id=$1", [order.id]);
        const { rows: payments } = await client.query("SELECT provider_id FROM payments WHERE order_id=$1 AND status='approved'", [order.id]);
        if (!payments.length || order.total_cents === 0) {
            await client.query("UPDATE orders SET status='refunded' WHERE id=$1", [order.id]);
            await client.query("UPDATE payments SET status='refunded' WHERE order_id=$1", [order.id]);
        } else {
            for (const payment of payments) {
                await job(client, "refund", "refund:" + payment.provider_id, { orderId: order.id, orgId, paymentId: payment.provider_id });
            }
        }
        await notify(client, order.user_id, "refund:" + order.id, "Reembolso solicitado", reason);
    }

    async function applyPayment(orgId, payment) {
        const { rows: [initial] } = await db.query("SELECT event_id FROM orders WHERE id=$1", [payment.orderId]);
        requireValue(initial, 404, "Pedido não encontrado.");
        return db.transaction(async (client) => {
            const { rows: [event] } = await client.query("SELECT * FROM events WHERE id=$1 FOR UPDATE", [initial.event_id]);
            const { rows: [order] } = await client.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [payment.orderId]);
            requireValue(!payment.provider || payment.provider === order.payment_provider, 400, "Provedor diferente do registrado no pedido.");
            requireValue(event.org_id === orgId && payment.currency === "BRL" && payment.amount === order.total_cents,
                400, "O pagamento não corresponde ao pedido.");
            const { rows: [previous] } = await client.query("SELECT * FROM payments WHERE provider_id=$1 FOR UPDATE", [payment.id]);
            requireValue(!previous || previous.order_id === order.id, 409, "Pagamento já vinculado a outro pedido.");
            if (previous?.status === "refunded" || previous?.status === "charged_back") return order;
            if (previous?.status === "approved" && !["approved", "refunded", "charged_back"].includes(payment.status)) return order;
            await client.query(`INSERT INTO payments(provider_id,order_id,status,amount_cents,provider_fee_cents)
                VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider_id) DO UPDATE
                SET status=EXCLUDED.status,provider_fee_cents=EXCLUDED.provider_fee_cents,updated_at=now()`,
            [payment.id, order.id, payment.status, payment.amount, payment.fee || 0]);

            if (payment.status === "refunded" || payment.status === "charged_back") {
                if (order.paid_payment_id && order.paid_payment_id !== payment.id) return order;
                await client.query("UPDATE orders SET status=$2 WHERE id=$1", [order.id, payment.status]);
                await notify(client, order.user_id, payment.status + ":" + order.id, "Ingresso cancelado",
                    "O pagamento foi estornado ou contestado. Consulte seu pedido.");
                return { ...order, status: payment.status };
            }
            if (payment.status !== "approved") return order;
            if (order.status === "paid" && previous?.status === "approved") return order;
            if (order.status === "paid") {
                await job(client, "refund", "refund:" + payment.id, { orderId: order.id, orgId, paymentId: payment.id });
                return order;
            }
            const counts = await stock(client, event.id, order.lot_id, order.id);
            const { rows: [lot] } = await client.query("SELECT capacity FROM lots WHERE id=$1", [order.lot_id]);
            const fulfillable = event.status !== "cancelled" && new Date(event.ends_at) > new Date()
                && ["pending", "expired"].includes(order.status)
                && counts.event_used + order.quantity <= event.capacity && counts.lot_used + order.quantity <= lot.capacity;
            if (!fulfillable) {
                await requestRefund(client, order, orgId, "O pagamento foi confirmado após o encerramento da reserva. O reembolso está em processamento.");
                return { ...order, status: "refund_pending" };
            }
            await client.query("UPDATE orders SET status='paid',paid_payment_id=$2 WHERE id=$1", [order.id, payment.id]);
            for (let sequence = 1; sequence <= order.quantity; sequence++) {
                await client.query("INSERT INTO tickets(order_id,sequence) VALUES($1,$2) ON CONFLICT(order_id,sequence) DO NOTHING", [order.id, sequence]);
            }
            await notify(client, order.user_id, "paid:" + order.id, "Ingresso confirmado", "Seu ingresso para " + event.name + " está disponível.", "/conta.html?pedido=" + order.id);
            return { ...order, status: "paid" };
        });
    }

    async function checkIn(userId, eventId, code) {
        const { rows: [event] } = await db.query("SELECT * FROM events WHERE id=$1", [eventId]);
        requireValue(event, 404, "Evento não encontrado.");
        await member(db, userId, event.org_id, ["owner", "manager", "checkin"]);
        const id = ticketId(code, config);
        if (!id) return { result: "invalid" };
        return db.transaction(async (client) => {
            const { rows: [currentEvent] } = await client.query("SELECT status FROM events WHERE id=$1 FOR SHARE", [eventId]);
            const { rows: [ticket] } = await client.query(`
                SELECT t.*,o.status,o.event_id,l.category,u.name AS holder
                FROM tickets t JOIN orders o ON o.id=t.order_id JOIN lots l ON l.id=o.lot_id
                JOIN users u ON u.id=o.user_id WHERE t.id=$1 FOR UPDATE OF t`, [id]);
            if (!ticket) return { result: "invalid" };
            if (ticket.event_id !== eventId) return { result: "other-event" };
            if (ticket.status !== "paid" || currentEvent.status === "cancelled") return { result: "cancelled" };
            if (ticket.checked_at) return { result: "used", checkedAt: ticket.checked_at };
            const { rows: [checked] } = await client.query("UPDATE tickets SET checked_at=now(),checked_by=$2 WHERE id=$1 AND checked_at IS NULL RETURNING checked_at", [id, userId]);
            await client.query("INSERT INTO audit_logs(org_id,actor_id,action,entity_id) VALUES($1,$2,'checkin',$3)", [event.org_id, userId, id]);
            return { result: "accepted", holder: ticket.holder, category: ticket.category, checkedAt: checked.checked_at };
        });
    }

    async function wallet(userId, orderId) {
        const values = orderId ? [userId, orderId] : [userId];
        const { rows } = await db.query(`
            SELECT o.*,e.name AS event_name,e.starts_at,e.place,e.status AS event_status,e.slug,l.category,
                COALESCE(json_agg(json_build_object('id',t.id,'checkedAt',t.checked_at)) FILTER(WHERE t.id IS NOT NULL),'[]') AS tickets
            FROM orders o JOIN events e ON e.id=o.event_id JOIN lots l ON l.id=o.lot_id
            LEFT JOIN tickets t ON t.order_id=o.id WHERE o.user_id=$1 ${orderId ? "AND o.id=$2" : ""}
            GROUP BY o.id,e.id,l.id ORDER BY o.created_at DESC LIMIT 100`, values);
        return rows.map((order) => ({ ...order, tickets: order.tickets.map((ticket) => ({
            ...ticket, code: order.status === "paid" && order.event_status !== "cancelled" ? ticketCode(ticket.id, config) : null
        })) }));
    }

    async function maintenance() {
        await db.query("UPDATE orders SET status='expired' WHERE status='pending' AND expires_at<now()");
        await db.query("DELETE FROM sessions WHERE expires_at<now()");
        await db.query("DELETE FROM login_links WHERE expires_at<now()");
        await db.query("DELETE FROM oauth_states WHERE expires_at<now()");
        await db.query("DELETE FROM rate_limits WHERE expires_at<now()");
        const { rows } = await db.query(`
            SELECT DISTINCT o.user_id,e.id,e.name FROM orders o JOIN events e ON e.id=o.event_id
            WHERE o.status='paid' AND e.status IN ('published','closed')
            AND e.starts_at>now() AND e.starts_at<now()+interval '24 hours'`);
        await db.transaction(async (client) => {
            for (const row of rows) {
                await notify(client, row.user_id, "reminder:" + row.id + ":" + row.user_id,
                    "Seu evento está chegando", row.name + " começa nas próximas 24 horas. Confira o local e seu ingresso.");
            }
        });
    }

    return { createOrder, applyPayment, checkIn, wallet, requestRefund, maintenance };
}
