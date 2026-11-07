import { sendNotification } from "web-push";
import { hash } from "./security.js";

export async function job(client, kind, key, payload) {
    await client.query("INSERT INTO jobs(kind,dedupe_key,payload) VALUES($1,$2,$3) ON CONFLICT(dedupe_key) DO NOTHING",
        [kind, key, JSON.stringify(payload)]);
}

export async function notify(client, userId, key, title, body, url = "/conta.html") {
    const { rows: [notice] } = await client.query(
        "INSERT INTO notices(user_id,dedupe_key,title,body,url) VALUES($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id",
        [userId, key, title, body, url]
    );
    if (!notice) return;
    const { rows: [user] } = await client.query("SELECT email FROM users WHERE id=$1", [userId]);
    await job(client, "email", key + ":email", { email: user.email, subject: title, text: body + "\n\n" + url });
    await job(client, "push", key + ":push", { userId, title, body, url, tag: notice.id });
}

export function notifications(db, config, paymentProvider, sendEmail) {
    async function mail(payload, id) {
        if (sendEmail) return sendEmail(payload);
        if (!config.resendKey || !config.emailFrom) {
            if (!config.production) {
                console.log("[E-mail local] " + payload.email + "\n" + payload.subject + "\n" + payload.text);
                return;
            }
            throw new Error("E-mail de produção não configurado.");
        }
        const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: "Bearer " + config.resendKey, "Content-Type": "application/json", "Idempotency-Key": id },
            body: JSON.stringify({ from: config.emailFrom, to: [payload.email], subject: payload.subject,
                text: payload.text.replace(/\n\n\//g, "\n\n" + config.url + "/") }),
            signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw new Error("Falha no envio de e-mail.");
    }

    async function push(payload) {
        const { rows } = await db.query("SELECT * FROM subscriptions WHERE user_id=$1", [payload.userId]);
        if (!rows.length) return;
        if (!config.vapidPublic || !config.vapidPrivate || !config.vapidSubject) {
            if (!config.production) return;
            throw new Error("Web Push não configurado.");
        }
        for (const subscription of rows) {
            try {
                await sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, JSON.stringify(payload), {
                    vapidDetails: { subject: config.vapidSubject, publicKey: config.vapidPublic, privateKey: config.vapidPrivate },
                    TTL: 86400, timeout: 10000
                });
            } catch (error) {
                if (error.statusCode === 404 || error.statusCode === 410) {
                    await db.query("DELETE FROM subscriptions WHERE id=$1", [subscription.id]);
                } else throw error;
            }
        }
    }

    async function refund(payload) {
        await paymentProvider.refund(payload.orgId, payload.paymentId, hash("refund:" + payload.paymentId));
        await db.transaction(async (client) => {
            await client.query("UPDATE payments SET status='refunded',updated_at=now() WHERE provider_id=$1", [payload.paymentId]);
            const { rows: [order] } = await client.query(
                "UPDATE orders SET status='refunded' WHERE id=$1 AND status='refund_pending' AND NOT EXISTS(SELECT 1 FROM payments WHERE order_id=$1 AND status='approved') RETURNING user_id",
                [payload.orderId]
            );
            if (order) await notify(client, order.user_id, "refunded:" + payload.orderId, "Reembolso confirmado", "O provedor confirmou o estorno. O prazo para aparecer na conta depende da forma de pagamento.");
        });
    }

    async function run(limit = 20, budget = Infinity) {
        const started = Date.now();
        let completed = 0;
        for (let index = 0; index < limit; index++) {
            if (budget - (Date.now() - started) < 31000) break;
            const { rows: [item] } = await db.query(`
                UPDATE jobs SET status='running',attempts=attempts+1,lease_until=now()+interval '2 minutes'
                WHERE id=(SELECT id FROM jobs WHERE
                    (status='queued' AND next_at<=now()) OR (status='running' AND lease_until<now())
                    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
                RETURNING *`);
            if (!item) break;
            try {
                if (item.kind === "email") await mail(item.payload, item.id);
                if (item.kind === "push") await push(item.payload);
                if (item.kind === "refund") await refund(item.payload, item.id);
                await db.query("UPDATE jobs SET status='done',lease_until=NULL,last_error=NULL WHERE id=$1", [item.id]);
                completed++;
            } catch (error) {
                await db.query(
                    "UPDATE jobs SET status=$2,next_at=$3,lease_until=NULL,last_error=$4 WHERE id=$1",
                    [item.id, item.attempts >= 8 ? "failed" : "queued", new Date(Date.now() + Math.min(3600000, 30000 * 2 ** item.attempts)),
                        error.message.slice(0, 300)]
                );
            }
        }
        return completed;
    }
    return { run };
}
