import { createHmac } from "node:crypto";
import { equal, seal, unseal, HttpError } from "./security.js";

export function payments(db, config, request = fetch) {
    function normalize(result) {
        return {
            id: String(result.id), orderId: result.external_reference, collectorId: String(result.collector_id),
            status: result.status, amount: Math.round(Number(result.transaction_amount) * 100),
            currency: result.currency_id, live: result.live_mode,
            fee: Math.round((result.fee_details || []).filter((item) => item.type !== "application_fee")
                .reduce((sum, item) => sum + Number(item.amount), 0) * 100)
        };
    }
    async function api(path, accessToken, body, method = "POST", idempotency) {
        const response = await request("https://api.mercadopago.com" + path, {
            method,
            headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json",
                ...(idempotency ? { "X-Idempotency-Key": idempotency } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new HttpError(502, "O provedor de pagamento não concluiu a operação. Tente novamente.");
        return response.json();
    }

    async function access(orgId) {
        return db.transaction(async (client) => {
            const { rows: [org] } = await client.query("SELECT * FROM organizations WHERE id=$1 FOR UPDATE", [orgId]);
            if (!org?.mp_access_token) throw new HttpError(409, "O organizador precisa conectar sua conta de recebimento.");
            if (new Date(org.mp_expires_at).getTime() > Date.now() + 60000) return unseal(org.mp_access_token, config);
            const result = await api("/oauth/token", "", {
                client_id: config.mpClientId, client_secret: config.mpClientSecret,
                grant_type: "refresh_token", refresh_token: unseal(org.mp_refresh_token, config)
            });
            await client.query(
                "UPDATE organizations SET mp_access_token=$2,mp_refresh_token=$3,mp_expires_at=$4 WHERE id=$1",
                [orgId, seal(result.access_token, config), seal(result.refresh_token, config), new Date(Date.now() + result.expires_in * 1000)]
            );
            return result.access_token;
        });
    }

    return {
        async connect(code, verifier) {
            return api("/oauth/token", "", {
                client_id: config.mpClientId, client_secret: config.mpClientSecret,
                grant_type: "authorization_code", code, code_verifier: verifier,
                redirect_uri: config.url + "/api/payments/connect/callback"
            });
        },
        async checkout(order, event, org) {
            const accessToken = await access(org.id);
            const result = await api("/checkout/preferences", accessToken, {
                items: [{ id: order.id, title: event.name, quantity: 1, unit_price: order.total_cents / 100, currency_id: "BRL" }],
                external_reference: order.id,
                marketplace_fee: order.fee_cents / 100,
                back_urls: {
                    success: config.url + "/conta.html?pedido=" + order.id,
                    pending: config.url + "/conta.html?pedido=" + order.id,
                    failure: config.url + "/conta.html?pedido=" + order.id
                },
                auto_return: "approved",
                notification_url: config.url + "/api/webhooks/mercadopago?org=" + org.id,
                expires: true,
                expiration_date_to: new Date(order.expires_at).toISOString(),
                payment_methods: { installments: 1, excluded_payment_types: [{ id: "ticket" }] }
            }, "POST", order.id);
            const checkoutUrl = config.mpProduction ? result.init_point : result.sandbox_init_point;
            if (!checkoutUrl || !/^https:\/\/([a-z0-9-]+\.)*(mercadopago\.com(\.br)?|mercadopago\.com\.ar)\//i.test(checkoutUrl)) {
                throw new HttpError(502, "O provedor retornou um endereço de checkout inválido.");
            }
            return { id: result.id, url: checkoutUrl };
        },
        async payment(orgId, id) {
            const result = await api("/v1/payments/" + encodeURIComponent(id), await access(orgId), null, "GET");
            return normalize(result);
        },
        async search(orgId, orderId) {
            const params = new URLSearchParams({ external_reference: orderId, sort: "date_created", criteria: "desc", limit: "50" });
            const result = await api("/v1/payments/search?" + params, await access(orgId), null, "GET");
            return (result.results || []).map(normalize);
        },
        async refund(orgId, id, key) {
            return api("/v1/payments/" + encodeURIComponent(id) + "/refunds", await access(orgId), {}, "POST", key);
        }
    };
}

export function verifyWebhook(req, config) {
    const signature = new Map(String(req.headers["x-signature"] || "").split(",").map((part) => part.trim().split("=")));
    const timestamp = signature.get("ts");
    const requestId = req.headers["x-request-id"];
    const id = req.query["data.id"];
    if (!config.mpWebhookSecret || typeof id !== "string" || !/^[a-z0-9-]{1,100}$/i.test(id)
        || !/^\d{10,13}$/.test(timestamp || "") || typeof requestId !== "string" || requestId.length > 200) return false;
    const time = Number(timestamp) * (timestamp.length === 10 ? 1000 : 1);
    if (Math.abs(Date.now() - time) > 600000) return false;
    const manifest = "id:" + id.toLowerCase() + ";request-id:" + requestId + ";ts:" + timestamp + ";";
    const digest = createHmac("sha256", config.mpWebhookSecret).update(manifest).digest("hex");
    return equal(digest, signature.get("v1") || "");
}
