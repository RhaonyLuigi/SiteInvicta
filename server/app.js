import express from "express";
import { z } from "zod";
import { authRouter, identify, authenticated } from "./auth.js";
import { organizerRouter } from "./organizers.js";
import { commerce, member } from "./commerce.js";
import { stripePayments } from "./stripe.js";
import { notifications, notify, job } from "./notifications.js";
import { tasks } from "./tasks.js";
import { requireValue, HttpError, hash } from "./security.js";

const uuid = z.uuid();
z.config(z.locales.pt());

export function createApp({ db, config, provider, sendEmail }) {
    const app = express();
    const ready = Boolean(db) && /^[a-f0-9]{64}$/i.test(config.encryptionKey);
    app.disable("x-powered-by");
    app.set("trust proxy", 1);
    app.use(express.json({ limit: "256kb", verify(req, res, bytes) { if (req.originalUrl.split("?")[0] === "/api/webhooks/stripe") req.rawBody = bytes; } }));
    app.use("/api", (req, res, next) => {
        res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method)
            && !req.path.startsWith("/webhooks/") && req.path !== "/jobs") {
            requireValue(req.headers.origin === config.url, 403, "Origem da solicitação inválida.");
        }
        next();
    });
    const stripe = stripePayments(db, config);
    const adapters = { stripe, mock: { refund: async () => ({ status: "refunded" }) } };
    const adapter = (name) => {
        requireValue(adapters[name], 409, "O provedor deste pedido foi desativado. Consulte o suporte.");
        return provider || adapters[name];
    };
    const paymentProvider = {
        async refund(orgId, id, key, orderId) {
            const { rows: [order] } = await db.query("SELECT payment_provider FROM orders WHERE id=$1", [orderId]);
            requireValue(order, 404, "Pedido não encontrado.");
            return adapter(order.payment_provider).refund(orgId, id, key);
        },
        search: (orgId, orderId, name) => adapter(name || config.paymentProvider).search(orgId, orderId)
    };
    const store = db ? commerce(db, config) : null;
    const delivery = db ? notifications(db, config, paymentProvider, sendEmail) : null;

    app.get("/api/health", (req, res) => res.json({
        ready, local: !config.production, paymentProvider: config.paymentProvider,
        emailReady: !config.production || Boolean(config.resendKey && config.emailFrom),
        pushReady: Boolean(config.vapidPublic && config.vapidPrivate && config.vapidSubject),
        vapidPublicKey: config.vapidPublic,
        reservationMinutes: config.paymentProvider === "stripe" ? 30 : 15,
        message: ready ? "" : "A plataforma está sendo configurada. As vendas serão abertas após a conexão do banco."
    }));
    app.use("/api", async (req, res, next) => {
        requireValue(ready, 503, "A plataforma está em configuração. Tente novamente mais tarde.");
        await identify(req, db, config);
        if (req.method === "POST" && !req.path.startsWith("/webhooks/") && req.path !== "/jobs") {
            const window = req.path.startsWith("/auth/") ? 900 : 60;
            const limit = req.path.startsWith("/auth/") ? 20 : 120;
            const key = hash((req.user?.id || req.ip) + ":" + req.path.split("/")[1] + ":" + Math.floor(Date.now() / (window * 1000)));
            const { rows: [rate] } = await db.query(
                "INSERT INTO rate_limits(key,expires_at) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET hits=rate_limits.hits+1 RETURNING hits",
                [key, new Date(Date.now() + window * 2000)]
            );
            requireValue(rate.hits <= limit, 429, "Muitas tentativas. Aguarde alguns minutos.");
        }
        next();
    });
    app.use("/api/auth", db ? authRouter(db, config, delivery) : (req, res) => res.sendStatus(503));
    app.get("/api/me", (req, res) => res.json({ user: req.user || null }));

    async function catalog(filter, values) {
        const { rows: events } = await db.query(`
            SELECT e.*,o.name AS organizer,
                COALESCE(o.fee_bps,$1::int) AS fee_bps,o.fee_mode,
                (o.stripe_ready OR $2::text='mock') AS connected
            FROM events e JOIN organizations o ON o.id=e.org_id
            WHERE e.status<>'draft' AND ${filter} ORDER BY e.starts_at LIMIT 100`, [config.feeBps, config.paymentProvider, ...values]);
        if (!events.length) return [];
        const { rows: lots } = await db.query(`
            SELECT l.*,GREATEST(0,LEAST(l.capacity-
                COALESCE((SELECT sum(quantity) FROM orders WHERE lot_id=l.id AND
                    (status IN ('paid','refund_pending') OR (status='pending' AND expires_at>now()))),0),
                e.capacity-COALESCE((SELECT sum(quantity) FROM orders WHERE event_id=e.id AND
                    (status IN ('paid','refund_pending') OR (status='pending' AND expires_at>now()))),0)))::int AS available
            FROM lots l JOIN events e ON e.id=l.event_id WHERE l.event_id=ANY($1::uuid[]) ORDER BY l.sales_start`,
        [events.map((event) => event.id)]);
        return events.map((event) => ({
            ...event, connected: undefined, lots: lots.filter((lot) => lot.event_id === event.id).map((lot) => ({
                ...lot,
                sellable: event.status === "published" && new Date(event.ends_at) > new Date() && !lot.closed && lot.available > 0
                    && new Date(lot.sales_start) <= new Date() && new Date(lot.sales_end) > new Date()
                    && (lot.price_cents === 0 || (event.fee_bps !== null && (event.connected || config.paymentProvider === "mock")))
            }))
        }));
    }
    app.get("/api/events", async (req, res) => {
        const query = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : "";
        const events = await catalog("e.status IN ('published','closed') AND e.ends_at>now() AND (e.name ILIKE $3 OR e.place ILIKE $3)", ["%" + query + "%"]);
        res.json({ events });
    });
    app.get("/api/events/:id", async (req, res) => {
        const id = z.string().max(120).parse(req.params.id);
        const [event] = await catalog("(e.id::text=$3 OR e.slug=$3)", [id]);
        requireValue(event, 404, "Evento não encontrado.");
        res.json(event);
    });
    app.use("/api/manage", authenticated, db ? organizerRouter(db, config, store) : (req, res) => res.sendStatus(503));

    app.post("/api/orders", authenticated, async (req, res) => {
        const input = z.object({ lotId: uuid, quantity: z.number().int().min(1).max(10), key: z.uuid() }).parse(req.body);
        let order = await store.createOrder(req.user.id, input.lotId, input.quantity, input.key);
        if (order.total_cents === 0 && order.status === "pending") {
            const { rows: [event] } = await db.query("SELECT org_id FROM events WHERE id=$1", [order.event_id]);
            order = await store.applyPayment(event.org_id, { id: "free:" + order.id, orderId: order.id, status: "approved", amount: 0, currency: "BRL", fee: 0 });
        }
        res.status(201).json(order);
    });
    app.get("/api/orders", authenticated, async (req, res) => res.json({ orders: await store.wallet(req.user.id) }));
    app.get("/api/orders/:id", authenticated, async (req, res) => {
        const [order] = await store.wallet(req.user.id, uuid.parse(req.params.id));
        requireValue(order, 404, "Pedido não encontrado.");
        res.json(order);
    });
    app.post("/api/orders/:id/checkout", authenticated, async (req, res) => {
        const id = uuid.parse(req.params.id);
        const { rows: [order] } = await db.query("SELECT * FROM orders WHERE id=$1 AND user_id=$2", [id, req.user.id]);
        requireValue(order, 404, "Pedido não encontrado.");
        requireValue(order.status === "pending" && new Date(order.expires_at) > new Date(), 409, "A reserva deste pedido encerrou. Escolha um novo ingresso.");
        if (order.payment_provider === "stripe") return res.json({ embedded: true, orderId: id });
        if (order.payment_provider === "mock") return res.json({ local: true, orderId: id });
        throw new HttpError(409, "Este pedido utiliza um provedor desativado. Faça uma nova reserva.");
    });
    app.post("/api/orders/:id/local-payment", authenticated, async (req, res) => {
        requireValue(!config.production && config.paymentProvider === "mock", 404, "Operação indisponível.");
        const { rows: [order] } = await db.query("SELECT o.*,e.org_id FROM orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1 AND o.user_id=$2", [uuid.parse(req.params.id), req.user.id]);
        requireValue(order, 404, "Pedido não encontrado.");
        const result = await store.applyPayment(order.org_id, { id: "local:" + order.id, orderId: order.id, amount: order.total_cents, status: "approved", currency: "BRL", fee: 0 });
        res.json(result);
    });
    app.post("/api/orders/:id/payment-session", authenticated, async (req, res) => {
        const { method } = z.object({ method: z.enum(["pix", "card"]) }).parse(req.body);
        const { rows: [order] } = await db.query("SELECT * FROM orders WHERE id=$1 AND user_id=$2", [uuid.parse(req.params.id), req.user.id]);
        requireValue(order, 404, "Pedido não encontrado.");
        requireValue(order.payment_provider === "stripe" && order.status === "pending" && new Date(order.expires_at) > new Date(), 409, "Este pedido não permite iniciar um novo pagamento. Atualize a conta.");
        const { rows: [claimed] } = await db.query("UPDATE orders SET checkout_lease_until=now()+interval '90 seconds' WHERE id=$1 AND (checkout_lease_until IS NULL OR checkout_lease_until<now()) RETURNING id", [order.id]);
        requireValue(claimed, 409, "O pagamento está sendo preparado. Aguarde alguns segundos.");
        try {
            const { rows: [event] } = await db.query("SELECT * FROM events WHERE id=$1", [order.event_id]);
            const { rows: [org] } = await db.query("SELECT * FROM organizations WHERE id=$1", [event.org_id]);
            res.json(await adapter("stripe").checkout(order, event, org, req.user, method));
        } finally { await db.query("UPDATE orders SET checkout_lease_until=NULL WHERE id=$1", [order.id]); }
    });
    app.post("/api/payments/stripe/onboard", authenticated, async (req, res) => {
        const { orgId } = z.object({ orgId: uuid }).parse(req.body);
        await member(db, req.user.id, orgId, ["owner"]);
        requireValue(config.paymentProvider === "stripe", 409, "O recebimento Stripe ainda não está ativado na plataforma.");
        try {
            res.json(await adapter("stripe").onboard(orgId, req.user));
        } catch (error) {
            if (error.type?.startsWith("Stripe")) {
                console.error("[Stripe cadastro]", error.type, error.code || "", error.param || "", error.requestId || "");
                const detail = error.code === "api_key_expired" || error.type === "StripeAuthenticationError"
                    ? "A chave Stripe da plataforma é inválida ou expirou. Confira as variáveis na Vercel e faça um novo deploy."
                    : error.type === "StripeConnectionError" ? "Não foi possível acessar a Stripe agora. Tente novamente em alguns instantes."
                    : "A Stripe não liberou o link de cadastro. Confira a configuração do Connect e as permissões da conta da plataforma. Referência: " + (error.requestId || "indisponível");
                throw new HttpError(502, detail);
            }
            throw error;
        }
    });
    app.post("/api/payments/stripe/status", authenticated, async (req, res) => {
        const { orgId } = z.object({ orgId: uuid }).parse(req.body);
        await member(db, req.user.id, orgId, ["owner"]);
        res.json(await adapter("stripe").syncAccount(orgId, true));
    });
    app.post("/api/webhooks/stripe", async (req, res) => {
        requireValue(config.stripeWebhookSecret && req.rawBody, 503, "Webhook Stripe não configurado.");
        let event;
        try { event = stripe.sdk().webhooks.constructEvent(req.rawBody, req.headers["stripe-signature"], config.stripeWebhookSecret); }
        catch { throw new HttpError(400, "Assinatura Stripe inválida."); }
        requireValue(event.livemode === Boolean(config.stripeProduction), 400, "Ambiente Stripe inválido.");
        const { rows: [org] } = await db.query("SELECT id,stripe_account_id FROM organizations WHERE stripe_account_id=$1", [event.account || ""]);
        if (!org) return res.json({ received: true });
        if (event.type === "account.updated") await adapter("stripe").syncAccount(org.id);
        if (["payment_intent.succeeded", "payment_intent.payment_failed", "charge.refunded", "charge.dispute.created", "checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
            const object = event.data.object;
            let id = object.object === "payment_intent" ? object.id : object.payment_intent;
            if (event.type === "charge.dispute.created") {
                const charge = await stripe.sdk().charges.retrieve(object.charge, {}, { stripeAccount: org.stripe_account_id });
                id = charge.payment_intent;
            }
            if (typeof id === "string") {
                const payment = await adapter("stripe").payment(org.id, id);
                requireValue(payment.live === Boolean(config.stripeProduction) && payment.collectorId === org.stripe_account_id, 400, "Pagamento fora do ambiente esperado.");
                await store.applyPayment(org.id, payment);
            }
        }
        res.json({ received: true });
    });
    app.post("/api/orders/:id/refund-request", authenticated, async (req, res) => {
        const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
        const { rows: [order] } = await db.query("SELECT * FROM orders WHERE id=$1 AND user_id=$2 AND status='paid'", [uuid.parse(req.params.id), req.user.id]);
        requireValue(order, 409, "Não foi encontrado um pedido pago para solicitar reembolso.");
        const { rows: [request] } = await db.query("INSERT INTO refund_requests(order_id,reason) VALUES($1,$2) ON CONFLICT(order_id) DO NOTHING RETURNING id", [order.id, reason]);
        requireValue(request, 409, "Este pedido já tem uma solicitação registrada. Consulte a resposta nos avisos.");
        res.json({ message: "Solicitação registrada. O organizador fará a análise conforme a política do evento." });
    });
    app.post("/api/checkin", authenticated, async (req, res) => {
        const input = z.object({ eventId: uuid, code: z.string().trim().max(200) }).parse(req.body);
        res.json(await store.checkIn(req.user.id, input.eventId, input.code));
    });

    app.get("/api/notices", authenticated, async (req, res) => {
        const { rows } = await db.query("SELECT * FROM notices WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100", [req.user.id]);
        res.json(rows);
    });
    app.post("/api/notices/read", authenticated, async (req, res) => {
        await db.query("UPDATE notices SET read_at=now() WHERE user_id=$1 AND read_at IS NULL", [req.user.id]);
        res.json({ ok: true });
    });
    app.post("/api/push", authenticated, async (req, res) => {
        const input = z.object({ endpoint: z.url().max(2000), keys: z.object({ p256dh: z.string().min(40).max(200), auth: z.string().min(15).max(100) }) }).parse(req.body);
        const endpoint = new URL(input.endpoint);
        requireValue(endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && !endpoint.port
            && /(^|\.)(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/.test(endpoint.hostname),
        400, "Serviço de notificações não reconhecido.");
        await db.query("INSERT INTO subscriptions(user_id,endpoint,keys) VALUES($1,$2,$3) ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,keys=EXCLUDED.keys",
            [req.user.id, input.endpoint, JSON.stringify(input.keys)]);
        res.json({ ok: true });
    });
    app.delete("/api/push", authenticated, async (req, res) => {
        const { endpoint } = z.object({ endpoint: z.string().max(2000) }).parse(req.body);
        await db.query("DELETE FROM subscriptions WHERE user_id=$1 AND endpoint=$2", [req.user.id, endpoint]);
        res.json({ ok: true });
    });

    app.use("/api/platform", authenticated, (req, res, next) => {
        requireValue(req.user.platformOwner, 403, "Acesso restrito à administração da plataforma.");
        next();
    });
    app.get("/api/platform", async (req, res) => {
        const { rows: organizations } = await db.query("SELECT id,name,fee_bps,fee_mode,stripe_account_id,stripe_ready FROM organizations ORDER BY created_at");
        const { rows: failedJobs } = await db.query("SELECT id,kind,status,attempts,last_error,created_at FROM jobs WHERE status='failed' ORDER BY created_at DESC LIMIT 100");
        res.json({ organizations, failedJobs });
    });
    app.patch("/api/platform/organizations/:id", async (req, res) => {
        const input = z.object({ feeBps: z.number().int().min(0).max(2000), feeMode: z.enum(["included", "added"]) }).parse(req.body);
        await db.query("UPDATE organizations SET fee_bps=$2,fee_mode=$3 WHERE id=$1", [uuid.parse(req.params.id), input.feeBps, input.feeMode]);
        await db.query("INSERT INTO audit_logs(actor_id,action,entity_id) VALUES($1,'commission',$2)", [req.user.id, req.params.id]);
        res.json({ ok: true });
    });
    app.post("/api/platform/jobs/:id/retry", async (req, res) => {
        await db.query("UPDATE jobs SET status='queued',attempts=0,next_at=now() WHERE id=$1 AND status='failed'", [uuid.parse(req.params.id)]);
        res.json({ ok: true });
    });
    async function jobs(req, res) {
        requireValue(config.cronSecret && req.headers.authorization === "Bearer " + config.cronSecret, 401, "Acesso restrito.");
        res.json(await tasks(db, config, paymentProvider, store, delivery));
    }
    app.get("/api/jobs", jobs);
    app.post("/api/jobs", jobs);
    app.use("/api", (req, res) => res.status(404).json({ message: "Rota não encontrada." }));
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        if (error instanceof z.ZodError) return res.status(400).json({ message: error.issues[0]?.message || "Confira os dados informados." });
        if (error.code === "23505") return res.status(409).json({ message: "Este registro já existe. Atualize a página." });
        if (error.code === "23503") return res.status(409).json({ message: "Este registro está associado a outros dados." });
        const status = error.status || (error.type === "entity.parse.failed" ? 400 : 500);
        if (status >= 500) console.error("[API]", error.message);
        res.status(status).json({ message: status >= 500 ? (error.status ? error.message : "Não foi possível concluir. Tente novamente.") : error.message });
    });
    return { app, store, delivery, tasks: () => tasks(db, config, paymentProvider, store, delivery) };
}
