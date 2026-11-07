import { availability, createOrder, eventUrl, money, readDemo, resolveOrder } from "./demo-store.js";
import qrcode from "./vendor/qrcode.mjs";

const byId = (id) => document.getElementById(id);
const list = byId("ticket-list");
const checkout = byId("checkout");
const form = byId("checkout-form");
const quantity = byId("quantity");
const status = byId("checkout-status");
const actions = byId("payment-actions");
const retry = byId("retry-payment");
const issued = byId("issued-tickets");
const validator = byId("open-validator");
const purchaseBar = byId("mobile-purchase");
const eventId = new URLSearchParams(location.search).get("evento") || "invicta";
const dayFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" });
const timeFormat = new Intl.DateTimeFormat("pt-BR", { timeStyle: "short" });
let selectedLot;
let currentOrder;
let heroVisible = true;
let ticketsVisible = false;
let hasAvailableTickets = false;

function updatePurchaseBar() {
    purchaseBar.hidden = heroVisible || ticketsVisible || !hasAvailableTickets || checkout.open;
}

function renderTickets(container, tickets) {
    container.replaceChildren();
    for (const ticket of tickets) {
        const card = byId("issued-ticket").content.cloneNode(true);
        const qr = qrcode(0, "M");
        qr.addData(ticket.code);
        qr.make();
        card.querySelector("img").src = qr.createDataURL(5);
        card.querySelector("code").textContent = ticket.code;
        container.append(card);
    }
    container.hidden = tickets.length === 0;
}

function renderCatalog() {
    const message = byId("catalog-message");
    try {
        const state = readDemo();
        const event = state.events.find((item) => item.id === eventId);
        const lots = state.lots.filter((item) => item.eventId === eventId);
        const available = lots.filter((lot) => !lot.closed && availability(state, lot) > 0);
        hasAvailableTickets = Boolean(event) && available.length > 0;
        updatePurchaseBar();
        list.replaceChildren();
        const showExperience = Boolean(event) && eventId === "invicta";
        document.querySelector(".event-facts").hidden = !event;
        byId("o-evento").hidden = !showExperience;
        byId("hero-merch").hidden = !showExperience;
        for (const link of document.querySelectorAll('[href="#o-evento"]')) {
            link.hidden = !showExperience;
        }
        if (!event) {
            byId("event-title").textContent = "Evento indisponível";
            byId("event-intro").textContent = "Abra a página inicial para ver o evento principal.";
            message.textContent = "Evento não encontrado neste navegador.";
            message.hidden = false;
            return;
        }
        const title = byId("event-title");
        title.textContent = event.name;
        if (event.name === "A Maior da UCB") {
            const accent = document.createElement("em");
            accent.textContent = "da UCB";
            title.replaceChildren(document.createTextNode("A Maior "), accent);
        }
        byId("event-intro").textContent = event.description;
        const date = new Date(event.date);
        byId("event-when").dateTime = event.date;
        byId("event-date").textContent = dayFormat.format(date);
        byId("event-time").textContent = timeFormat.format(date);
        const [venue, ...address] = event.place.split(" · ");
        byId("event-place").textContent = venue;
        byId("event-address").textContent = address.join(" · ");
        byId("event-address").hidden = address.length === 0;
        byId("event-price").textContent = available.length
            ? money(Math.min(...available.map((lot) => lot.price)))
            : "Indisponíveis";
        byId("event-price-note").hidden = available.length === 0;
        byId("mobile-price").textContent = byId("event-price").textContent;
        message.textContent = "Este evento ainda não tem lotes cadastrados.";
        message.hidden = lots.length !== 0;

        for (const lot of lots) {
            const card = byId("lot-card").content.cloneNode(true);
            const remaining = availability(state, lot);
            const button = card.querySelector("button");
            card.querySelector("[data-lot-name]").textContent = lot.name;
            card.querySelector("[data-lot-category]").textContent = lot.category;
            card.querySelector("[data-lot-price]").textContent = money(lot.price).replace(/\u00a0/g, " ");
            card.querySelector("[data-lot-description]").textContent = lot.description;
            card.querySelector("[data-lot-availability]").textContent = lot.closed ? "Lote encerrado" : remaining + " disponíveis";
            button.textContent = lot.closed ? "Lote encerrado" : remaining ? "Comprar " + lot.category : "Esgotado";
            button.disabled = lot.closed || remaining === 0;
            button.dataset.lotId = lot.id;
            button.addEventListener("click", () => openCheckout(lot, remaining, state));
            list.append(card);
        }

        const savedTickets = state.tickets.filter((ticket) => ticket.eventId === eventId && ticket.orderId);
        byId("saved-tickets").hidden = savedTickets.length === 0;
        if (byId("saved-tickets").open) renderTickets(byId("saved-ticket-list"), savedTickets);
    } catch {
        hasAvailableTickets = false;
        updatePurchaseBar();
        message.textContent = "Não foi possível abrir os dados de demonstração neste navegador.";
        message.hidden = false;
    }
}

function updateTotal() {
    byId("checkout-total").value = quantity.validity.valid ? money(quantity.valueAsNumber * selectedLot.price) : "—";
    document.querySelector('[data-quantity-step="-1"]').disabled = quantity.valueAsNumber <= Number(quantity.min);
    document.querySelector('[data-quantity-step="1"]').disabled = quantity.valueAsNumber >= Number(quantity.max);
    if (quantity.getAttribute("aria-invalid") === "true") validateQuantity();
}

function validateQuantity() {
    const valid = quantity.validity.valid;
    const error = byId("quantity-error");
    quantity.setAttribute("aria-invalid", String(!valid));
    error.textContent = valid ? "" : "Escolha uma quantidade inteira de 1 a " + quantity.max + ".";
    error.hidden = valid;
    return valid;
}

function setCheckoutStep(step) {
    for (const item of document.querySelectorAll("[data-checkout-step]")) {
        if (item.dataset.checkoutStep === step) item.setAttribute("aria-current", "step");
        else item.removeAttribute("aria-current");
    }
}

function showOrder(message = "Pedido criado. Escolha o resultado do pagamento de teste.") {
    setCheckoutStep("confirmation");
    form.hidden = true;
    actions.hidden = false;
    retry.hidden = true;
    status.textContent = message;
}

function openCheckout(lot, remaining, state) {
    selectedLot = lot;
    currentOrder = state.orders.findLast((order) => order.lotId === lot.id && order.status === "pending");
    byId("checkout-lot").textContent = lot.name + " · " + lot.category + " · " + money(lot.price) + " por ingresso";
    quantity.max = Math.min(5, remaining);
    quantity.value = 1;
    quantity.removeAttribute("aria-invalid");
    byId("quantity-error").hidden = true;
    byId("quantity-error").textContent = "";
    byId("quantity-help").textContent = Number(quantity.max) === 1
        ? "Há 1 ingresso disponível neste lote."
        : "Escolha entre 1 e " + quantity.max + " ingressos.";
    setCheckoutStep("review");
    updateTotal();
    form.hidden = false;
    status.textContent = "";
    actions.hidden = true;
    retry.hidden = true;
    issued.hidden = true;
    validator.hidden = true;
    if (currentOrder) {
        showOrder("Pedido pendente · " + currentOrder.quantity + " ingresso(s) · " + money(currentOrder.quantity * currentOrder.price));
    }
    if (!checkout.open) checkout.showModal();
    updatePurchaseBar();
    (currentOrder ? byId("approve-payment") : quantity).focus();
}

form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!validateQuantity()) {
        quantity.focus();
        return;
    }
    try {
        currentOrder = createOrder(eventId, selectedLot.id, quantity.valueAsNumber);
        showOrder("Pagamento de teste pendente · " + money(currentOrder.quantity * currentOrder.price));
        byId("approve-payment").focus();
    } catch (error) {
        status.textContent = error.message;
    }
});

function finishPayment(result) {
    try {
        const response = resolveOrder(currentOrder.id, result);
        currentOrder = null;
        actions.hidden = true;
        retry.hidden = response.tickets.length > 0;
        status.textContent = response.message;
        renderTickets(issued, response.tickets);
        validator.href = eventUrl("validador.html", eventId);
        validator.hidden = response.tickets.length === 0;
        (retry.hidden ? checkout.querySelector("[method=dialog] button") : retry).focus();
    } catch (error) {
        status.textContent = error.message;
        actions.hidden = true;
        retry.hidden = false;
        retry.focus();
    }
}

byId("approve-payment").addEventListener("click", () => finishPayment("approved"));
byId("decline-payment").addEventListener("click", () => finishPayment("declined"));
byId("retry-payment").addEventListener("click", () => {
    try {
        const state = readDemo();
        const lot = state.lots.find((item) => item.id === selectedLot.id);
        const remaining = lot && !lot.closed ? availability(state, lot) : 0;
        if (remaining === 0) {
            status.textContent = "Este lote ficou indisponível. Feche o checkout para escolher outro.";
            return;
        }
        openCheckout(lot, remaining, state);
    } catch {
        status.textContent = "Não foi possível acessar os lotes de demonstração.";
    }
});
quantity.addEventListener("input", updateTotal);
quantity.addEventListener("blur", validateQuantity);
for (const button of document.querySelectorAll("[data-quantity-step]")) {
    button.addEventListener("click", () => {
        quantity.stepUp(Number(button.dataset.quantityStep));
        updateTotal();
    });
}
checkout.addEventListener("close", () => {
    if (checkout.open) return;
    renderCatalog();
    const button = [...list.querySelectorAll("button")].find((item) => item.dataset.lotId === selectedLot.id);
    (button && !button.disabled ? button : byId("tickets-title")).focus();
});
byId("saved-tickets").addEventListener("toggle", () => {
    if (byId("saved-tickets").open) renderCatalog();
});
window.addEventListener("storage", () => {
    if (!checkout.open) renderCatalog();
});

renderCatalog();

const purchaseObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
        if (entry.target.id === "hero") heroVisible = entry.isIntersecting;
        else ticketsVisible = entry.isIntersecting;
    }
    updatePurchaseBar();
});
purchaseObserver.observe(byId("hero"));
purchaseObserver.observe(byId("ingressos"));

if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const revealObserver = new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                entry.target.classList.add("is-visible");
                observer.unobserve(entry.target);
            }
        }
    }, { threshold: 0.08 });
    for (const element of document.querySelectorAll(".reveal")) revealObserver.observe(element);
    document.documentElement.classList.add("motion-ready");
}

if (eventId === "invicta") {
    const videos = [...document.querySelectorAll("video[data-src]")];
    const toggle = byId("motion-toggle");
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

    function updateToggle() {
        const playing = videos.some((video) => !video.paused);
        const label = playing ? "Pausar vídeos" : "Reproduzir vídeos";
        toggle.dataset.playing = playing;
        toggle.setAttribute("aria-label", label);
        byId("motion-label").textContent = label;
    }

    function setPlayback(playing) {
        for (const video of videos) {
            if (playing) {
                if (!video.hasAttribute("src")) video.src = video.dataset.src;
                video.play().catch(updateToggle);
            } else {
                video.pause();
            }
        }
        updateToggle();
    }

    for (const video of videos) {
        video.addEventListener("playing", updateToggle);
        video.addEventListener("pause", updateToggle);
    }
    toggle.hidden = false;
    toggle.addEventListener("click", () => setPlayback(videos.every((video) => video.paused)));
    reduceMotion.addEventListener("change", (event) => setPlayback(!event.matches));
    setPlayback(!reduceMotion.matches);
}
