import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { configuration } from "../server/config.js";
import { database, migrate, localKey } from "../server/db.js";
import { createApp } from "../server/app.js";
import { hash, token, seal } from "../server/security.js";
import { payments } from "../server/payments.js";
import { Pool } from "pg";

let db, runtime, server, config, origin;
const emails = [];
const refunded = [];
const providerPayments = new Map();
let owner, buyer, outsider;
let bootstrap, testSchema;
before(async () => {
    config = configuration({ production: false, localPath: ":memory:", databaseUrl: "", ownerEmail: "owner@invicta.test", paymentProvider: "mock",
        encryptionKey: "11".repeat(32), mpWebhookSecret: "webhook-test", feeBps: null, mpProduction: false, cronSecret: "cron-test" });
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
test("webhook confere assinatura, conta, valor e resiste a repetição", async () => {
    const f = await fixture();
    const purchase = (await order(f)).data;
    await db.query("UPDATE organizations SET mp_user_id='collector-test' WHERE id=$1", [f.org.id]);
    providerPayments.set("12345", { id: "12345", orderId: purchase.id, amount: purchase.total_cents, currency: "BRL", status: "approved", collectorId: "collector-test", live: false, fee: 50 });
    const timestamp = String(Date.now()), requestId = randomUUID();
    const digest = createHmac("sha256", config.mpWebhookSecret).update("id:12345;request-id:" + requestId + ";ts:" + timestamp + ";").digest("hex");
    const path = "/webhooks/mercadopago?org=" + f.org.id + "&data.id=12345";
    assert.equal((await call(path, null, {}, "POST")).status, 401);
    const headers = { "x-signature": "ts=" + timestamp + ",v1=" + digest, "x-request-id": requestId };
    assert.equal((await call(path, null, {}, "POST", headers)).status, 200);
    assert.equal((await call(path, null, {}, "POST", headers)).status, 200);
    assert.equal((await call("/orders/" + purchase.id, buyer)).data.tickets.length, 1);
    const original = providerPayments.get("12345");
    for (const invalid of [{ collectorId: "other-account" }, { live: true }, { amount: purchase.total_cents + 1 }, { currency: "USD" }]) {
        providerPayments.set("12345", { ...original, ...invalid });
        assert.equal((await call(path, null, {}, "POST", headers)).status, 400);
    }
    providerPayments.set("12345", original);
});
test("conciliação recupera pagamento sem webhook e depois revoga contestação", async () => {
    const f = await fixture();
    const purchase = (await order(f)).data;
    await db.query("UPDATE organizations SET mp_user_id='reconcile-collector' WHERE id=$1", [f.org.id]);
    await db.query("UPDATE orders SET preference_id='test-preference' WHERE id=$1", [purchase.id]);
    const payment = { id: "reconcile-payment", orderId: purchase.id, amount: purchase.total_cents, currency: "BRL", status: "approved", collectorId: "reconcile-collector", live: false, fee: 50 };
    providerPayments.set(payment.id, payment);
    const previous = config.paymentProvider;
    config.paymentProvider = "mercadopago";
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
test("adaptador Mercado Pago envia comissão e total ao checkout", async () => {
    const f = await fixture();
    const purchase = (await order(f)).data;
    await db.query("UPDATE organizations SET mp_access_token=$2,mp_refresh_token=$3,mp_expires_at=now()+interval '1 day' WHERE id=$1", [f.org.id, seal("test-access", config), seal("test-refresh", config)]);
    let payload;
    const gateway = payments(db, config, async (url, options) => {
        payload = JSON.parse(options.body);
        return new Response(JSON.stringify({ id: "preference", sandbox_init_point: "https://sandbox.mercadopago.com.br/checkout/test" }), { status: 200 });
    });
    const result = await gateway.checkout(purchase, f.event, f.org);
    assert.equal(result.id, "preference");
    assert.equal(payload.items[0].unit_price, 50);
    assert.equal(payload.marketplace_fee, 2.5);
    assert.equal(payload.external_reference, purchase.id);
});
test("Web Push rejeita destinos arbitrários e jobs requerem segredo", async () => {
    assert.equal((await call("/push", buyer, { endpoint: "https://127.0.0.1/secret", keys: { p256dh: "a".repeat(70), auth: "b".repeat(24) } })).status, 400);
    assert.equal((await call("/jobs", null, {}, "POST")).status, 401);
    assert.equal((await call("/jobs", null, {}, "POST", { authorization: "Bearer cron-test" })).status, 200);
});
test("produção não admite pagamentos simulados", () => {
    assert.throws(() => configuration({ production: true, url: "https://example.com", paymentProvider: "mock" }));
});
