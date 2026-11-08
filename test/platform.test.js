import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { configuration } from "../server/config.js";
import { database, migrate, localKey } from "../server/db.js";
import { createApp } from "../server/app.js";
import { hash, token } from "../server/security.js";
import { Pool } from "pg";
import Stripe from "stripe";
import { stripePayments } from "../server/stripe.js";

let db, runtime, server, config, origin;
const emails = [];
const refunded = [];
const providerPayments = new Map();
let owner, buyer, outsider;
let bootstrap, testSchema;
before(async () => {
    config = configuration({ production: false, localPath: ":memory:", databaseUrl: "", ownerEmail: "owner@invicta.test", paymentProvider: "mock",
        encryptionKey: "11".repeat(32), feeBps: null, cronSecret: "cron-test" });
    if (process.env.TEST_DATABASE_URL) {
        bootstrap = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
        testSchema = "invicta_test_" + randomUUID().replaceAll("-", "");
        await bootstrap.query('CREATE SCHEMA "' + testSchema + '"');
        const url = new URL(process.env.TEST_DATABASE_URL);
        url.searchParams.set("options", "-c search_path=" + testSchema);
        config.databaseUrl = url.href;
    }
    db = await database(config); await migrate(db);
    runtime = createApp({ db, config, sendEmail: async (mail) => emails.push(mail), provider: {
        refund: async (org, id) => { refunded.push(id); return { status: "refunded" }; },
        payment: async (org, id) => providerPayments.get(id),
        search: async (org, id) => [...providerPayments.values()].filter((payment) => payment.orderId === id)
    } });
    server = runtime.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    origin = "http://127.0.0.1:" + server.address().port;
    config.url = origin;
    owner = await identity("owner@invicta.test");
    buyer = await identity("buyer@invicta.test");
    outsider = await identity("outsider@invicta.test");
});
after(async () => {
    server?.close(); await db?.close();
    if (bootstrap) {
        assert.match(testSchema, /^invicta_test_[a-f0-9]{32}$/);
        await bootstrap.query('DROP SCHEMA "' + testSchema + '" CASCADE');
        await bootstrap.end();
    }
});

async function identity(email) {
    const { rows: [user] } = await db.query("INSERT INTO users(email,name) VALUES($1,$2) RETURNING *", [email, email.split("@")[0]]);
    const secret = token();
    await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [hash(secret), user.id]);
    return { ...user, cookie: "invicta_session=" + secret };
}
async function call(path, user, body, method = body ? "POST" : "GET", headers = {}) {
    const response = await fetch(origin + "/api" + path, {
        method, headers: { origin, ...(user ? { cookie: user.cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
}
async function fixture(capacity = 10, price = 5000, mode = "included") {
    const org = await call("/manage/organizations", owner, { name: "Organização " + randomUUID() });
    assert.equal(org.status, 201);
    await call("/platform/organizations/" + org.data.id, owner, { feeBps: 500, feeMode: mode }, "PATCH");
    const start = new Date(Date.now() + 7 * 86400000).toISOString();
    const end = new Date(Date.now() + 8 * 86400000).toISOString();
    const event = await call("/manage/organizations/" + org.data.id + "/events", owner, {
        name: "Evento de teste", description: "Teste da plataforma", place: "Brasília", startsAt: start, endsAt: end,
        capacity, coverUrl: "/assets/atmosfera-invicta.webp", refundPolicy: "Entre em contato com a organização para analisar solicitações."
    });
    assert.equal(event.status, 201);
    const lot = await call("/manage/events/" + event.data.id + "/lots", owner, {
        name: "Lote inicial", category: "Público geral", description: "Acesso ao evento", priceCents: price, capacity,
        salesStart: new Date(Date.now() - 10000).toISOString(), salesEnd: start, closed: false
    });
    assert.equal(lot.status, 201);
    assert.equal((await call("/manage/events/" + event.data.id + "/status", owner, { status: "published" })).status, 200);
    return { org: org.data, event: event.data, lot: lot.data };
}
async function order(f, user = buyer, quantity = 1, key = randomUUID()) {
    return call("/orders", user, { lotId: f.lot.id, quantity, key });
}
async function pay(f, value, paymentId = randomUUID()) {
    return runtime.store.applyPayment(f.org.id, { id: paymentId, orderId: value.id, amount: value.total_cents, currency: "BRL", status: "approved", fee: 100 });
}

test("produção seleciona Stripe mesmo com configuração antiga de provedor na hospedagem", () => {
    const previousNode = process.env.NODE_ENV, previousProvider = process.env.PAYMENT_PROVIDER;
    try {
        process.env.NODE_ENV = "production";
        process.env.PAYMENT_PROVIDER = "removed-provider";
        assert.equal(configuration({ url: "https://invicta.test" }).paymentProvider, "stripe");
    } finally {
        if (previousNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNode;
        if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER; else process.env.PAYMENT_PROVIDER = previousProvider;
    }
});

test("estrutura antiga é removida e pedidos de provedor desativado não iniciam cobrança", async () => {
    const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('organizations','orders') AND table_schema=current_schema()")).rows.map((row) => row.column_name);
    assert.equal(columns.some((name) => name.startsWith("mp_") || ["preference_id", "checkout_url"].includes(name)), false);
    assert.equal((await call("/payments/connect", owner, { orgId: randomUUID() })).status, 404);
    const f = await fixture();
    const purchase = (await order(f)).data;
    await db.query("UPDATE orders SET payment_provider='disabled-provider' WHERE id=$1", [purchase.id]);
    assert.equal((await call("/orders/" + purchase.id + "/checkout", buyer, {})).status, 409);
    assert.equal((await call("/orders/" + purchase.id + "/payment-session", buyer, { method: "pix" })).status, 409);
});

test("Stripe separa Pix e cartões, desconta comissão e reutiliza sessões sem duplicar cobrança", async () => {
    const f = await fixture();
    const value = (await order(f)).data;
    const accountId = "acct_" + randomUUID();
    await db.query("UPDATE organizations SET stripe_account_id=$2 WHERE id=$1", [f.org.id, accountId]);
    await db.query("UPDATE orders SET payment_provider='stripe' WHERE id=$1", [value.id]);
    value.payment_provider = "stripe";
    f.org.stripe_account_id = accountId;
    const calls = [], sessions = new Map();
    let active = true, refundComplete = false;
    const stripeConfig = { ...config, stripeSecret: "sk_test_fixture", stripePublic: "pk_test_fixture", stripeProduction: false, url: "https://ingressos.example.com" };
    const sdk = {
        accounts: { retrieve: async () => ({ country: "BR", charges_enabled: true, payouts_enabled: true, capabilities: { card_payments: "active", pix_payments: active ? "active" : "pending" } }) },
        paymentMethodDomains: { list: async () => ({ data: [] }), create: async (data, options) => { assert.equal(options.stripeAccount, accountId); assert.equal(data.domain_name, "ingressos.example.com"); return { enabled: true }; } },
        checkout: { sessions: {
            create: async (data, options) => { calls.push({ data, options }); const session = { id: "cs_" + calls.length, status: "open", client_secret: "secret_" + calls.length }; sessions.set(session.id, session); return session; },
            retrieve: async (id, data, options) => { assert.equal(options.stripeAccount, accountId); return sessions.get(id); }
        } },
        refunds: {
            create: async (data, options) => { assert.equal(data.refund_application_fee, true); assert.equal(options.stripeAccount, accountId); return { id: "re_fixture", status: "pending" }; },
            retrieve: async () => ({ id: "re_fixture", status: refundComplete ? "succeeded" : "pending" })
        }
    };
    const adapter = stripePayments(db, stripeConfig, sdk);
    assert.equal((await adapter.syncAccount(f.org.id, true)).walletDomainReady, true);
    const first = await adapter.checkout(value, f.event, f.org, buyer, "pix");
    assert.deepEqual(await adapter.checkout(value, f.event, f.org, buyer, "pix"), first);
    await adapter.checkout(value, f.event, f.org, buyer, "card");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].data.payment_method_types, ["pix"]);
    assert.deepEqual(calls[1].data.payment_method_types, ["card"]);
    assert.equal(calls[0].data.line_items[0].price_data.unit_amount, value.total_cents);
    assert.equal(calls[0].data.payment_intent_data.application_fee_amount, 250);
    assert.equal(calls[0].data.ui_mode, "elements");
    assert.equal(calls[0].options.stripeAccount, accountId);
    assert.notEqual(calls[0].options.idempotencyKey, calls[1].options.idempotencyKey);
    active = false;
    await assert.rejects(adapter.checkout(value, f.event, f.org, buyer, "pix"), /habilitar Pix/);
    await assert.rejects(adapter.refund(f.org.id, "pi_fixture", "refund_fixture"), /ainda não foi concluído/);
    refundComplete = true;
    assert.equal((await adapter.refund(f.org.id, "pi_fixture", "refund_fixture")).status, "succeeded");
    assert.throws(() => stripePayments(db, { ...stripeConfig, stripeProduction: true }, sdk).sdk(), /ambiente/);
});

test("Stripe protege sessão privada e só emite ingresso após webhook assinado e pagamento conferido", async () => {
    const f = await fixture();
    const value = (await order(f)).data;
    const accountId = "acct_" + randomUUID();
    await db.query("UPDATE organizations SET stripe_account_id=$2,stripe_ready=true WHERE id=$1", [f.org.id, accountId]);
    await db.query("UPDATE orders SET payment_provider='stripe' WHERE id=$1", [value.id]);
    const stripeConfig = { ...config, paymentProvider: "stripe", stripeSecret: "sk_test_fixture", stripePublic: "pk_test_fixture", stripeWebhookSecret: "whsec_fixture", stripeProduction: false };
    let payment = { provider: "stripe", id: "pi_" + randomUUID(), orderId: value.id, collectorId: accountId, amount: value.total_cents, currency: "BRL", status: "approved", live: false };
    const stripeRuntime = createApp({ db, config: stripeConfig, provider: {
        checkout: async (o, event, org, user, method) => { assert.equal(o.total_cents, 5000); return { clientSecret: "cs_private", method }; },
        payment: async () => payment
    } });
    const listener = stripeRuntime.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => listener.once("listening", resolve));
    const address = "http://127.0.0.1:" + listener.address().port;
    stripeConfig.url = address;
    const request = async (path, body, user = buyer, headers = {}) => {
        const response = await fetch(address + "/api" + path, { method: "POST", headers: { origin: address, cookie: user.cookie, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
        return { status: response.status, data: await response.json() };
    };
    try {
        const path = "/orders/" + value.id + "/payment-session";
        assert.equal((await request(path, { method: "pix" }, outsider)).status, 404);
        assert.equal((await request(path, { method: "cash" })).status, 400);
        assert.equal((await request(path, { method: "pix", total: 1 })).data.method, "pix");
        assert.equal((await db.query("SELECT count(*)::int AS n FROM tickets WHERE order_id=$1", [value.id])).rows[0].n, 0);
        const event = { id: "evt_fixture", type: "payment_intent.succeeded", account: accountId, livemode: false, data: { object: { id: payment.id, object: "payment_intent" } } };
        const webhook = async (body, signature) => request("/webhooks/stripe", body, buyer, { "stripe-signature": signature || Stripe.webhooks.generateTestHeaderString({ payload: JSON.stringify(body), secret: stripeConfig.stripeWebhookSecret }) });
        assert.equal((await webhook(event, "invalid")).status, 400);
        assert.equal((await webhook({ ...event, livemode: true })).status, 400);
        payment = { ...payment, amount: 1 };
        assert.equal((await webhook(event)).status, 400);
        payment = { ...payment, amount: value.total_cents, provider: "disabled-provider" };
        assert.equal((await webhook(event)).status, 400);
        payment = { ...payment, provider: "stripe" };
        assert.equal((await webhook(event)).status, 200);
        assert.equal((await webhook(event)).status, 200);
        assert.equal((await db.query("SELECT count(*)::int AS n FROM tickets WHERE order_id=$1", [value.id])).rows[0].n, 1);
        assert.equal((await request(path, { method: "card" })).status, 409);
        const another = (await order(f)).data;
        await db.query("UPDATE orders SET payment_provider='stripe',expires_at=now()-interval '1 second' WHERE id=$1", [another.id]);
        assert.equal((await request("/orders/" + another.id + "/payment-session", { method: "pix" })).status, 409);
    } finally { await new Promise((resolve) => listener.close(resolve)); }
});

test("login por e-mail é de uso único, cria sessão e preserva retorno", async () => {
    await db.query("INSERT INTO jobs(kind,dedupe_key,payload) VALUES('email','older-email',$1)", [JSON.stringify({ email: "older@invicta.test", subject: "Aviso anterior", text: "Aviso na fila" })]);
    const response = await call("/auth/request", null, { name: "Pessoa nova", email: "new@invicta.test", returnTo: "/admin.html" });
    assert.equal(response.status, 200);
    assert.equal(emails.some((mail) => mail.email === "older@invicta.test"), false);
    const mail = emails.find((item) => item.email === "new@invicta.test");
    const url = new URL(mail.text.match(/http[^\s]+/)[0]);
    assert.equal(url.searchParams.get("voltar"), "/admin.html");
    const secret = new URLSearchParams(url.hash.slice(1)).get("acesso");
    const login = await call("/auth/verify", null, { token: secret });
    assert.equal(login.status, 200);
    assert.match(login.headers.get("set-cookie"), /HttpOnly/i);
    assert.equal((await call("/auth/verify", null, { token: secret })).status, 401);
    assert.equal((await call("/auth/request", null, { name: "Pessoa", email: "x@invicta.test" }, "POST", { origin: "https://outro.test" })).status, 403);
});
test("comissão pendente bloqueia publicação de venda paga", async () => {
    const org = await call("/manage/organizations", owner, { name: "Pendente" });
    const f = await fixture();
    await db.query("UPDATE events SET org_id=$2 WHERE id=$1", [f.event.id, org.data.id]);
    assert.equal((await call("/manage/events/" + f.event.id + "/status", owner, { status: "published" })).status, 409);
    assert.equal((await call("/platform/organizations/" + org.data.id, outsider, { feeBps: 100, feeMode: "included" }, "PATCH")).status, 403);
});
test("preço é definido no servidor, pedido é idempotente e privado", async () => {
    const f = await fixture();
    const key = randomUUID();
    const first = await order(f, buyer, 2, key);
    const retry = await order(f, buyer, 2, key);
    assert.equal(first.status, 201);
    assert.equal(first.data.id, retry.data.id);
    assert.equal(first.data.total_cents, 10000);
    assert.equal(first.data.fee_cents, 500);
    assert.equal((await order(f, buyer, 1, key)).status, 409);
    assert.equal((await call("/orders/" + first.data.id, outsider)).status, 404);
    assert.equal((await call("/orders", null, { lotId: f.lot.id, quantity: 1, key: randomUUID() })).status, 401);
    const added = await fixture(10, 5000, "added");
    assert.equal((await order(added)).data.total_cents, 5250);
});
test("últimas vagas nunca são vendidas acima da capacidade", async () => {
    const f = await fixture(2);
    const people = await Promise.all([identity(randomUUID() + "@test.com"), identity(randomUUID() + "@test.com"), identity(randomUUID() + "@test.com")]);
    const results = await Promise.all(people.map((person) => order(f, person)));
    assert.equal(results.filter((result) => result.status === 201).length, 2);
    assert.equal(results.filter((result) => result.status === 409).length, 1);
});
test("pagamento repetido emite uma vez e check-in concorrente aceita uma vez", async () => {
    const f = await fixture();
    const purchase = (await order(f)).data;
    const paymentId = randomUUID();
    await Promise.all([pay(f, purchase, paymentId), pay(f, purchase, paymentId)]);
    const wallet = (await call("/orders/" + purchase.id, buyer)).data;
    assert.equal(wallet.tickets.length, 1);
    assert.equal(wallet.status, "paid");
    const input = { eventId: f.event.id, code: wallet.tickets[0].code };
    assert.equal((await call("/checkin", outsider, input)).status, 403);
    const checks = await Promise.all([call("/checkin", owner, input), call("/checkin", owner, input)]);
    assert.deepEqual(checks.map((item) => item.data.result).sort(), ["accepted", "used"]);
    const another = await fixture();
    assert.equal((await call("/checkin", owner, { ...input, eventId: another.event.id })).data.result, "other-event");
    assert.equal((await call("/checkin", owner, { ...input, code: input.code + "x" })).data.result, "invalid");
});
test("pagamento atrasado sem vaga gera reembolso e não emite ingresso", async () => {
    const f = await fixture(1);
    const late = (await order(f)).data;
    await db.query("UPDATE orders SET expires_at=now()-interval '1 second',status='expired' WHERE id=$1", [late.id]);
    const other = (await order(f, outsider)).data;
    await pay(f, other);
    await pay(f, late, "late-" + randomUUID());
    const wallet = (await call("/orders/" + late.id, buyer)).data;
    assert.equal(wallet.status, "refund_pending");
    assert.equal(wallet.tickets.length, 0);
    await runtime.delivery.run(100);
    assert.equal((await call("/orders/" + late.id, buyer)).data.status, "refunded");
});
test("reembolso de pagamento duplicado preserva ingresso pago original", async () => {
    const f = await fixture();
    const purchase = (await order(f)).data;
    const first = randomUUID(), duplicate = randomUUID();
    await pay(f, purchase, first); await pay(f, purchase, duplicate);
    await runtime.delivery.run(100);
    assert.ok(refunded.includes(duplicate));
    assert.equal((await call("/orders/" + purchase.id, buyer)).data.status, "paid");
    await runtime.store.applyPayment(f.org.id, { id: duplicate, orderId: purchase.id, amount: purchase.total_cents, currency: "BRL", status: "refunded" });
    assert.equal((await call("/orders/" + purchase.id, buyer)).data.status, "paid");
});
test("cancelamento revoga ingressos, devolve pagamentos e mantém isolamento", async () => {
    const f = await fixture();
    const purchase = (await order(f)).data;
    await pay(f, purchase);
    const code = (await call("/orders/" + purchase.id, buyer)).data.tickets[0].code;
    assert.equal((await call("/manage/events/" + f.event.id + "/status", outsider, { status: "cancelled" })).status, 403);
    assert.equal((await call("/manage/events/" + f.event.id + "/status", owner, { status: "cancelled" })).status, 200);
    assert.equal((await call("/checkin", owner, { eventId: f.event.id, code })).data.result, "cancelled");
    await runtime.delivery.run(100);
    assert.equal((await call("/orders/" + purchase.id, buyer)).data.status, "refunded");
});
test("eventos gratuitos emitem ingresso sem cobrança", async () => {
    const f = await fixture(5, 0);
    const purchase = await order(f);
    assert.equal(purchase.data.status, "paid");
    assert.equal((await call("/orders/" + purchase.data.id, buyer)).data.tickets.length, 1);
});
test("conciliação recupera pagamento sem webhook e depois revoga contestação", async () => {
    const f = await fixture();
    const purchase = (await order(f)).data;
    await db.query("UPDATE organizations SET stripe_account_id='reconcile-collector' WHERE id=$1", [f.org.id]);
    await db.query("UPDATE orders SET payment_provider='stripe' WHERE id=$1", [purchase.id]);
    await db.query("INSERT INTO checkout_sessions(order_id,method,session_id) VALUES($1,'pix',$2)", [purchase.id, "cs_" + purchase.id]);
    const payment = { id: "reconcile-payment", orderId: purchase.id, amount: purchase.total_cents, currency: "BRL", status: "approved", collectorId: "reconcile-collector", live: false, fee: 50 };
    providerPayments.set(payment.id, payment);
    const previous = config.paymentProvider;
    config.paymentProvider = "stripe";
    try {
        await runtime.tasks();
        assert.equal((await call("/orders/" + purchase.id, buyer)).data.status, "paid");
        providerPayments.set(payment.id, { ...payment, status: "charged_back" });
        await db.query("UPDATE orders SET reconciled_at=NULL WHERE id=$1", [purchase.id]);
        await runtime.tasks();
        const wallet = (await call("/orders/" + purchase.id, buyer)).data;
        assert.equal(wallet.status, "charged_back");
        assert.equal(wallet.tickets[0].code, null);
    } finally { config.paymentProvider = previous; }
});
test("convite exige e-mail correto e portaria não permite gestão nem exportação", async () => {
    const f = await fixture();
    const staff = await identity("staff-" + randomUUID() + "@invicta.test");
    assert.equal((await call("/manage/organizations/" + f.org.id + "/invitations", owner, { email: staff.email, role: "checkin" })).status, 201);
    await runtime.delivery.run(100);
    const link = emails.find((mail) => mail.email === staff.email).text.match(/http[^\s]+/)[0];
    const secret = new URLSearchParams(new URL(link).hash.slice(1)).get("convite");
    assert.equal((await call("/manage/invitations/accept", outsider, { token: secret })).status, 400);
    assert.equal((await call("/manage/invitations/accept", staff, { token: secret })).status, 200);
    assert.equal((await call("/manage/invitations/accept", staff, { token: secret })).status, 400);
    assert.equal((await call("/manage/events/" + f.event.id + "/status", staff, { status: "cancelled" })).status, 403);
    assert.equal((await call("/manage/events/" + f.event.id + "/participants.csv", staff)).status, 403);
    const purchase = (await order(f)).data; await pay(f, purchase);
    const code = (await call("/orders/" + purchase.id, buyer)).data.tickets[0].code;
    assert.equal((await call("/checkin", staff, { eventId: f.event.id, code })).data.result, "accepted");
});
test("pedido de reembolso é privado, analisado uma vez e revoga o ingresso", async () => {
    const f = await fixture();
    const purchase = (await order(f)).data; await pay(f, purchase);
    const path = "/orders/" + purchase.id + "/refund-request";
    assert.equal((await call(path, outsider, { reason: "Não poderei comparecer" })).status, 409);
    assert.equal((await call(path, buyer, { reason: "Não poderei comparecer" })).status, 200);
    assert.equal((await call(path, buyer, { reason: "Nova solicitação" })).status, 409);
    const summary = (await call("/manage/organizations/" + f.org.id, owner)).data;
    const requestId = summary.refunds[0].id;
    assert.equal((await call("/manage/refunds/" + requestId, outsider, { approve: true, reason: "Devolução aprovada" })).status, 403);
    assert.equal((await call("/manage/refunds/" + requestId, owner, { approve: true, reason: "Devolução aprovada" })).status, 200);
    assert.equal((await call("/manage/refunds/" + requestId, owner, { approve: true, reason: "Devolução aprovada" })).status, 409);
    await runtime.delivery.run(100);
    assert.equal((await call("/orders/" + purchase.id, buyer)).data.status, "refunded");
});
test("Web Push rejeita destinos arbitrários e jobs requerem segredo", async () => {
    assert.equal((await call("/push", buyer, { endpoint: "https://127.0.0.1/secret", keys: { p256dh: "a".repeat(70), auth: "b".repeat(24) } })).status, 400);
    assert.equal((await call("/jobs", null, {}, "POST")).status, 401);
    assert.equal((await call("/jobs", null, {}, "POST", { authorization: "Bearer cron-test" })).status, 200);
});
test("produção não admite pagamentos simulados", () => {
    assert.throws(() => configuration({ production: true, url: "https://example.com", paymentProvider: "mock" }));
});
