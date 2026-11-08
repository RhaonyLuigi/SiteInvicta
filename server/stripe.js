import Stripe from "stripe";
import { HttpError, requireValue } from "./security.js";

export function stripePayments(db, config, suppliedClient) {
    let client = suppliedClient;
    function sdk() {
        requireValue(config.stripeSecret && config.stripePublic, 503, "O pagamento está sendo configurado. Tente novamente mais tarde.");
        const live = config.stripeSecret.startsWith("sk_live_");
        requireValue(config.stripeSecret.startsWith(live ? "sk_live_" : "sk_test_") && live === Boolean(config.stripeProduction) && config.stripePublic.startsWith(live ? "pk_live_" : "pk_test_"), 503, "As chaves Stripe não correspondem ao ambiente configurado.");
        return client ||= new Stripe(config.stripeSecret, { timeout: 12000, maxNetworkRetries: 1 });
    }
    async function organization(id) {
        const { rows: [org] } = await db.query("SELECT * FROM organizations WHERE id=$1", [id]);
        requireValue(org?.stripe_account_id, 409, "O organizador precisa conectar sua conta de recebimento.");
        return org;
    }
    async function syncAccount(orgId, registerDomain = false) {
        const org = await organization(orgId);
        const account = await sdk().accounts.retrieve(org.stripe_account_id);
        const ready = account.country === "BR" && account.charges_enabled && account.payouts_enabled
            && account.capabilities?.card_payments === "active" && account.capabilities?.pix_payments === "active";
        await db.query("UPDATE organizations SET stripe_ready=$2 WHERE id=$1", [orgId, Boolean(ready)]);
        let walletDomainReady = false;
        if (registerDomain && new URL(config.url).protocol === "https:") {
            const domain_name = new URL(config.url).hostname;
            const options = { stripeAccount: org.stripe_account_id };
            const domains = await sdk().paymentMethodDomains.list({ domain_name, limit: 1 }, options);
            const domain = domains.data[0] || await sdk().paymentMethodDomains.create({ domain_name }, { ...options, idempotencyKey: "domain:" + orgId + ":" + domain_name });
            walletDomainReady = Boolean(domain.enabled);
        }
        return { ready: Boolean(ready), detailsSubmitted: Boolean(account.details_submitted), walletDomainReady };
    }
    async function payment(orgId, paymentId) {
        const org = await organization(orgId);
        const intent = await sdk().paymentIntents.retrieve(paymentId, { expand: ["latest_charge.balance_transaction"] }, { stripeAccount: org.stripe_account_id });
        const charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
        const status = charge?.disputed ? "charged_back" : charge?.amount_refunded > 0 ? "refunded"
            : intent.status === "succeeded" ? "approved" : intent.status === "canceled" ? "cancelled" : "pending";
        return { provider: "stripe", id: intent.id, orderId: intent.metadata?.order_id, collectorId: org.stripe_account_id,
            status, amount: intent.amount, currency: intent.currency?.toUpperCase(), live: intent.livemode,
            fee: typeof charge?.balance_transaction === "object" ? (charge.balance_transaction.fee_details || [])
                .filter((fee) => fee.type !== "application_fee").reduce((total, fee) => total + fee.amount, 0) : 0 };
    }
    return {
        sdk, payment, syncAccount,
        async onboard(orgId) {
            let { rows: [org] } = await db.query("SELECT * FROM organizations WHERE id=$1", [orgId]);
            requireValue(org, 404, "Organização não encontrada.");
            if (!org.stripe_account_id) {
                const account = await sdk().accounts.create({ type: "standard", country: "BR",
                    capabilities: { card_payments: { requested: true }, transfers: { requested: true }, pix_payments: { requested: true } },
                    metadata: { org_id: orgId }, business_profile: { product_description: "Venda de ingressos de eventos" } },
                { idempotencyKey: "org:" + orgId });
                await db.query("UPDATE organizations SET stripe_account_id=$2 WHERE id=$1 AND stripe_account_id IS NULL", [orgId, account.id]);
                org = await organization(orgId);
            }
            const link = await sdk().accountLinks.create({ account: org.stripe_account_id, type: "account_onboarding",
                refresh_url: config.url + "/admin.html?recebimento=retomar", return_url: config.url + "/admin.html?recebimento=verificar" });
            requireValue(new URL(link.url).protocol === "https:" && new URL(link.url).hostname.endsWith(".stripe.com"), 502, "Endereço de cadastro inválido.");
            return { url: link.url };
        },
        async checkout(order, event, org, user, method) {
            requireValue(order.payment_provider === "stripe", 409, "Este pedido utiliza outro provedor de pagamento.");
            const state = await syncAccount(org.id);
            requireValue(state.ready, 409, "O organizador precisa concluir o cadastro e habilitar Pix e cartões para receber.");
            requireValue(order.total_cents >= 50, 409, "O valor mínimo de pagamento é R$ 0,50.");
            const { rows: [saved] } = await db.query("SELECT session_id FROM checkout_sessions WHERE order_id=$1 AND method=$2", [order.id, method]);
            let session;
            if (saved) session = await sdk().checkout.sessions.retrieve(saved.session_id, {}, { stripeAccount: org.stripe_account_id });
            else {
                session = await sdk().checkout.sessions.create({ mode: "payment", ui_mode: "elements", locale: "pt-BR",
                    payment_method_types: [method], customer_email: user.email, client_reference_id: order.id,
                    ...(method === "pix" ? { payment_method_options: { pix: { expires_after_seconds: 1800 } } } : {}),
                    line_items: [{ quantity: 1, price_data: { currency: "brl", unit_amount: order.total_cents, product_data: { name: event.name + " · " + order.quantity + " ingresso(s)" } } }],
                    payment_intent_data: { application_fee_amount: order.fee_cents, metadata: { order_id: order.id, org_id: org.id } },
                    // Stripe exige pelo menos 30 minutos. O instante fixo preserva a idempotência após timeout.
                    metadata: { order_id: order.id }, expires_at: Math.floor(new Date(order.expires_at).getTime() / 1000) + 1800,
                    return_url: config.url + "/conta.html?pedido=" + order.id + "&retorno=1" }, { stripeAccount: org.stripe_account_id, idempotencyKey: "checkout:" + order.id + ":" + method });
                await db.query("INSERT INTO checkout_sessions(order_id,method,session_id) VALUES($1,$2,$3) ON CONFLICT(order_id,method) DO NOTHING", [order.id, method, session.id]);
            }
            requireValue(session.status === "open" && session.client_secret, 409, "Este pagamento já foi finalizado ou expirou. Atualize seus pedidos.");
            return { clientSecret: session.client_secret, accountId: org.stripe_account_id, publicKey: config.stripePublic, method };
        },
        async refund(orgId, id, key) {
            const org = await organization(orgId);
            const result = await sdk().refunds.create({ payment_intent: id, refund_application_fee: true }, { stripeAccount: org.stripe_account_id, idempotencyKey: key });
            const current = result.status === "succeeded" ? result : await sdk().refunds.retrieve(result.id, {}, { stripeAccount: org.stripe_account_id });
            if (current.status !== "succeeded") throw new HttpError(502, "O estorno ainda não foi concluído pela Stripe.");
            return current;
        },
        async search(orgId, orderId) {
            const org = await organization(orgId);
            const { rows } = await db.query("SELECT session_id FROM checkout_sessions WHERE order_id=$1", [orderId]);
            const results = [];
            for (const row of rows) {
                const session = await sdk().checkout.sessions.retrieve(row.session_id, {}, { stripeAccount: org.stripe_account_id });
                if (session.payment_intent) results.push(await payment(orgId, typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id));
            }
            return results;
        }
    };
}
