import { api, date, money, message, element, button, action } from "./api.js";
import { install, standalone, subscribe, unsubscribe, offlineWallet } from "./pwa.js";
import qrcode from "../vendor/qrcode.mjs";
import { openPayment, closePayment } from "./checkout.js";

const byId = (id) => document.getElementById(id);
let health;
let user;
let pending = false;
const params = new URLSearchParams(location.search);
const fragment = new URLSearchParams(location.hash.slice(1));
const access = fragment.get("acesso");
const invitation = fragment.get("convite");
if (location.hash) history.replaceState(null, "", location.pathname + location.search);
window.addEventListener("hashchange", () => {
    if (/[#&](acesso|convite)=/.test(location.hash)) location.reload();
});
function returnPath() {
    if (invitation) return "/conta.html#convite=" + encodeURIComponent(invitation);
    const value = params.get("voltar");
    if (value && value.startsWith("/") && !value.startsWith("//") && new URL(value, location.origin).origin === location.origin) return value;
    return "/conta.html";
}
const labels = { pending: "Aguardando pagamento", paid: "Confirmado", expired: "Reserva encerrada", cancelled: "Cancelado", refund_pending: "Reembolso em processamento", refunded: "Reembolsado", charged_back: "Pagamento contestado" };
function renderWallet(orders, offline = false) {
    byId("wallet-section").hidden = false;
    const list = byId("wallet");
    list.replaceChildren();
    pending = orders.some((order) => order.status === "pending");
    if (!orders.length) list.append(element("p", "Você ainda não tem ingressos. Escolha um evento para começar.", "muted"));
    for (const order of orders) {
        if (order.status !== "pending") closePayment(order.id);
        const card = element("article", null, "card order-card");
        card.append(element("h3", order.event_name), element("p", date(order.starts_at) + " · " + order.place, "muted"),
            element("p", order.quantity + " ingresso(s) · " + order.category), element("p", labels[order.status] || order.status, "order-state"),
            element("p", "Total " + money(order.total_cents), "price-small"));
        if (order.fee_mode === "added") card.append(element("p", "Inclui " + money(order.fee_cents) + " de taxa da plataforma.", "field-help"));
        if (order.status === "pending" && !offline) {
            card.append(element("p", "Reserva até " + date(order.expires_at), "field-help"));
            card.append(button(order.payment_provider === "stripe" ? "Pagar com Pix ou cartão" : "Continuar pagamento", async () => {
                if (order.payment_provider === "stripe") return openPayment(order);
                const result = await api("/orders/" + order.id + "/checkout", { method: "POST" });
                if (result.local) {
                    message("Ambiente local. Use a confirmação local para testar a emissão.");
                    return;
                }
                location.assign(result.url);
            }));
            if (health.local && health.paymentProvider === "mock") card.append(button("Confirmar pagamento local", async () => {
                await api("/orders/" + order.id + "/local-payment", { method: "POST" });
                await refresh();
            }, true));
        }
        const tickets = element("div", null, "wallet-tickets");
        for (const ticket of order.tickets || []) {
            if (!ticket.code) continue;
            const item = element("div", null, "wallet-ticket");
            const qr = qrcode(0, "M");
            qr.addData(ticket.code);
            qr.make();
            const image = element("img");
            image.src = qr.createDataURL(5, 16);
            image.width = 180;
            image.height = 180;
            image.alt = "QR Code do ingresso de " + order.event_name;
            item.append(image, element("p", user?.name || "Titular do pedido"), element("code", ticket.code), element("p", ticket.checkedAt ? "Entrada registrada" : "Apresente na portaria", "field-help"));
            tickets.append(item);
        }
        card.append(tickets);
        if (order.status === "paid" && !offline) {
            const details = element("details");
            details.append(element("summary", "Solicitar reembolso"));
            const form = element("form", null, "stack");
            const label = element("label", "Motivo da solicitação");
            label.htmlFor = "reason-" + order.id;
            const reason = element("textarea");
            reason.id = label.htmlFor; reason.name = "reason"; reason.required = true; reason.minLength = 5; reason.maxLength = 500;
            const submit = element("button", "Enviar solicitação", "button button-secondary");
            submit.type = "submit";
            form.append(label, reason, submit);
            action(form, async (data) => {
                const result = await api("/orders/" + order.id + "/refund-request", { method: "POST", body: data });
                message(result.message); details.open = false;
            });
            details.append(form); card.append(details);
        }
        list.append(card);
    }
}
async function refresh() {
    const { orders } = await api("/orders");
    renderWallet(orders);
    await offlineWallet({ userId: user.id, name: user.name, orders, savedAt: new Date().toISOString() }).catch(() => {});
    const notices = await api("/notices");
    const list = byId("notice-list");
    list.replaceChildren();
    if (!notices.length) list.append(element("p", "Os avisos de seus eventos aparecem aqui.", "muted"));
    for (const notice of notices.slice(0, 10)) {
        const item = element("article", null, "notice-item");
        const link = element("a", notice.title);
        link.href = notice.url;
        item.append(link, element("p", notice.body), element("time", date(notice.created_at), "field-help"));
        list.append(item);
    }
    return orders;
}
async function loggedIn() {
    byId("login").hidden = true;
    byId("account-settings").hidden = false;
    byId("person").textContent = user.name + " · " + user.email;
    const actions = byId("account-actions");
    if (invitation) actions.append(button("Aceitar convite", async () => {
        await api("/manage/invitations/accept", { method: "POST", body: { token: invitation } });
        location.assign("/admin.html");
    }));
    if (user.platformOwner) {
        const link = element("a", "Administração da plataforma", "button button-secondary");
        link.href = "/plataforma.html"; actions.append(link);
    }
    actions.append(button("Atualizar", refresh, true), button("Sair", async () => {
        const registration = await navigator.serviceWorker?.getRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) await api("/push", { method: "DELETE", body: { endpoint: subscription.endpoint } });
        await api("/auth/logout", { method: "POST" });
        await unsubscribe().catch(() => {});
        await offlineWallet(null);
        location.assign("/conta.html");
    }, true));
    const device = byId("device-actions");
    if (!standalone()) device.append(button("Instalar aplicativo", async () => message(await install()), true));
    device.append(button("Ativar notificações", async () => {
        const subscription = await subscribe(health.vapidPublicKey);
        await api("/push", { method: "POST", body: subscription.toJSON() });
        message("Notificações ativadas neste aparelho.");
    }), button("Desativar notificações", async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) await api("/push", { method: "DELETE", body: { endpoint: subscription.endpoint } });
        await unsubscribe();
        message("Notificações desativadas neste aparelho.");
    }, true));
    const orders = await refresh();
    const purchase = orders.find((order) => order.id === params.get("pedido") && order.payment_provider === "stripe" && order.status === "pending" && new Date(order.expires_at) > new Date());
    if (purchase && !params.has("retorno")) await openPayment(purchase);
}
action(byId("login-form"), async (data) => {
    const result = await api("/auth/request", { method: "POST", body: { ...data, returnTo: returnPath() } });
    message(result.message);
});
byId("read-notices").addEventListener("click", async () => {
    try { await api("/notices/read", { method: "POST" }); message("Avisos marcados como lidos."); }
    catch (error) { message(error.message, true); }
});
try {
    health = await api("/health");
    if (!health.ready) throw new Error(health.message);
    if (access) {
        ({ user } = await api("/auth/verify", { method: "POST", body: { token: access } }));
        const back = returnPath();
        if (back !== "/conta.html") { location.assign(back); }
        else await loggedIn();
    } else {
        ({ user } = await api("/me"));
        if (user) await loggedIn();
        else { byId("login").hidden = false; await offlineWallet(null).catch(() => {}); }
    }
} catch (error) {
    const saved = await offlineWallet().catch(() => null);
    if (!navigator.onLine && saved) {
        user = { name: saved.name };
        renderWallet(saved.orders, true);
        message("Consulta offline. Última atualização em " + date(saved.savedAt) + ". A validade será conferida online na portaria.");
    } else {
        byId("login").hidden = !health?.ready;
        message(error.message, true);
    }
}
const refreshTimer = setInterval(async () => {
    if (user && pending && document.visibilityState === "visible" && navigator.onLine) {
        try { await refresh(); } catch { /* A atualização manual permanece disponível. */ }
    }
}, 10000);
window.addEventListener("pagehide", () => clearInterval(refreshTimer), { once: true });
