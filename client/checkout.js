import { api, element, money, date } from "./api.js";

let sdkPromise;
let activeOrder;
let generation = 0;
let mounted = [];
let expiryTimer;
function stripeSdk() {
    if (window.Stripe) return Promise.resolve(window.Stripe);
    return sdkPromise ||= new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://js.stripe.com/endive/stripe.js";
        script.onload = () => window.Stripe ? resolve(window.Stripe) : reject(new Error("Não foi possível iniciar o pagamento."));
        script.onerror = () => { sdkPromise = undefined; script.remove(); reject(new Error("Não foi possível carregar o pagamento. Confira sua conexão e tente novamente.")); };
        document.head.append(script);
    });
}
function cleanup() {
    generation++;
    clearInterval(expiryTimer);
    for (const item of mounted) item.destroy();
    mounted = [];
}
export function closePayment(orderId) {
    if (orderId && orderId !== activeOrder) return;
    cleanup();
    document.getElementById("payment-panel")?.remove();
    activeOrder = undefined;
}
export async function openPayment(order) {
    closePayment();
    activeOrder = order.id;
    const panel = element("section", null, "card payment-panel stack");
    panel.id = "payment-panel";
    panel.setAttribute("aria-labelledby", "payment-title");
    const heading = element("h2", "Pagar ingresso"); heading.id = "payment-title"; heading.tabIndex = -1;
    const close = element("button", "Fechar pagamento", "button button-secondary"); close.type = "button";
    close.addEventListener("click", () => { closePayment(); document.getElementById("wallet-section")?.scrollIntoView({ block: "start" }); });
    const header = element("div", null, "section-heading"); header.append(heading, close);
    panel.append(header, element("p", order.event_name), element("p", "Total " + money(order.total_cents), "price-small"),
        element("p", "Reserva até " + date(order.expires_at), "field-help"));
    const choices = element("div", null, "button-group"); choices.setAttribute("role", "group"); choices.setAttribute("aria-label", "Forma de pagamento");
    const pix = element("button", "Pagar com Pix", "button"); pix.type = "button";
    const card = element("button", "Cartão ou carteira digital", "button button-secondary"); card.type = "button";
    choices.append(pix, card);
    const help = element("p", "Use o Pix Copia e Cola no aplicativo do seu banco. O ingresso será liberado após a confirmação.", "field-help");
    const status = element("p", "Preparando pagamento…", "notice"); status.setAttribute("role", "status");
    const content = element("div", null, "stack");
    panel.append(choices, help, status, content);
    document.getElementById("wallet-section").before(panel);
    panel.scrollIntoView({ block: "start", behavior: "instant" }); heading.focus({ preventScroll: true });
    async function select(method) {
        cleanup();
        const current = generation;
        content.replaceChildren();
        pix.disabled = true; card.disabled = true;
        pix.setAttribute("aria-pressed", String(method === "pix")); card.setAttribute("aria-pressed", String(method === "card"));
        status.textContent = "Preparando pagamento…"; status.hidden = false;
        help.textContent = method === "pix" ? "Gere o Pix e confirme o pagamento no aplicativo do seu banco. Não feche a página até conferir o resultado."
            : "Apple Pay e Google Pay aparecem nos aparelhos e navegadores compatíveis. Você também pode preencher seu cartão.";
        try {
            const session = await api("/orders/" + order.id + "/payment-session", { method: "POST", body: { method } });
            const factory = await stripeSdk();
            if (current !== generation) return;
            const stripe = factory(session.publicKey, { stripeAccount: session.accountId, locale: "pt-BR" });
            const checkout = stripe.initCheckoutElementsSdk({ clientSecret: session.clientSecret,
                elementsOptions: { appearance: { theme: "stripe", variables: { colorPrimary: "#1b6047", borderRadius: "12px" } } } });
            const loaded = await checkout.loadActions();
            if (current !== generation) return;
            if (loaded.type !== "success") throw new Error("Não foi possível abrir o formulário de pagamento. Atualize seus pedidos.");
            const form = element("form", null, "stack");
            if (method === "card") {
                const walletBox = element("div"); walletBox.id = "express-payment"; walletBox.hidden = true;
                const express = checkout.createExpressCheckoutElement({ paymentMethods: { applePay: "auto", googlePay: "auto", link: "never", amazonPay: "never", paypal: "never", klarna: "never" }, paymentMethodOrder: ["apple_pay", "google_pay"] });
                mounted.push(express);
                express.on("ready", (event) => { walletBox.hidden = !event.availablePaymentMethods?.applePay && !event.availablePaymentMethods?.googlePay; });
                express.on("confirm", async (event) => {
                    try {
                        const result = await loaded.actions.confirm({ expressCheckoutConfirmEvent: event });
                        if (result.type === "error") status.textContent = result.error.message;
                        else status.textContent = "Aguardando a confirmação do pagamento…";
                    } catch { status.textContent = "Não foi possível concluir com a carteira digital. Confira o pedido antes de tentar novamente."; }
                    status.hidden = false;
                });
                form.append(walletBox); content.append(form); express.mount(walletBox);
            } else content.append(form);
            const fields = element("div"); fields.id = "secure-payment-fields";
            const submit = element("button", method === "pix" ? "Gerar Pix" : "Pagar " + money(order.total_cents), "button"); submit.type = "submit";
            submit.disabled = true;
            form.append(fields, submit);
            const payment = checkout.createPaymentElement({ layout: "accordion", paymentMethodOrder: [method] });
            mounted.push(payment); payment.mount(fields);
            checkout.on("change", (state) => { submit.disabled = !state.canConfirm; });
            form.addEventListener("submit", async (event) => {
                event.preventDefault(); submit.disabled = true;
                try {
                    const result = await loaded.actions.confirm();
                    status.textContent = result.type === "error" ? result.error.message : "Aguardando confirmação. Seu ingresso aparecerá na conta assim que o pagamento for confirmado.";
                } catch { status.textContent = "Não foi possível concluir. Confira seu pedido antes de tentar novamente."; }
                finally { status.hidden = false; submit.disabled = false; }
            });
            status.hidden = true;
        } catch (error) { if (current === generation) { status.textContent = error.message; status.hidden = false; } }
        finally { if (current === generation) { pix.disabled = false; card.disabled = false; } }
        if (current === generation) expiryTimer = setInterval(() => {
            if (new Date(order.expires_at) <= new Date()) {
                cleanup(); content.replaceChildren(); pix.disabled = true; card.disabled = true;
                status.textContent = "A reserva encerrou. Confira seus pedidos antes de fazer uma nova reserva."; status.hidden = false;
            }
        }, 1000);
    }
    pix.addEventListener("click", () => select("pix")); card.addEventListener("click", () => select("card"));
    await select("pix");
}
window.addEventListener("pagehide", () => closePayment());
