import { availability, createOrder, eventUrl, formatEventDate, money, readDemo, resolveOrder } from "./demo-store.js";
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
const eventId = new URLSearchParams(location.search).get("evento") || "invicta";
let selectedLot;
let currentOrder;

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
        list.replaceChildren();
        if (!event) {
            byId("event-title").textContent = "Evento indisponível";
            byId("event-intro").textContent = "Abra a página inicial para ver o evento principal.";
            document.querySelector(".event-facts").hidden = true;
            byId("event-details").hidden = true;
            message.textContent = "Evento não encontrado neste navegador.";
            message.hidden = false;
            return;
        }
        byId("event-title").textContent = event.name;
        byId("event-intro").textContent = event.description;
        byId("event-date").textContent = formatEventDate(event.date);
        byId("event-place").textContent = event.place;
        byId("event-price").textContent = available.length
            ? "A partir de " + money(Math.min(...available.map((lot) => lot.price)))
            : "Sem ingressos disponíveis";
        byId("event-details").hidden = eventId !== "invicta";
        message.textContent = "Este evento ainda não tem lotes cadastrados.";
        message.hidden = lots.length !== 0;

        for (const lot of lots) {
            const card = byId("lot-card").content.cloneNode(true);
            const remaining = availability(state, lot);
            const button = card.querySelector("button");
            card.querySelector("[data-lot-name]").textContent = lot.name;
            card.querySelector("[data-lot-category]").textContent = lot.category;
            card.querySelector("[data-lot-price]").textContent = money(lot.price);
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
        message.textContent = "Não foi possível abrir os dados de demonstração neste navegador.";
        message.hidden = false;
    }
}

function updateTotal() {
    byId("checkout-total").value = quantity.validity.valid ? money(quantity.valueAsNumber * selectedLot.price) : "—";
}

function showOrder(message = "Pedido criado. Escolha o resultado do pagamento de teste.") {
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
    (currentOrder ? byId("approve-payment") : quantity).focus();
}

form.addEventListener("submit", (event) => {
    event.preventDefault();
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

const hero = byId("hero");
const video = byId("hero-video");
const header = document.querySelector(".site-header");
const motion = matchMedia("(prefers-reduced-motion: reduce)");
const scrollDistance = 420;
let pendingFrame = 0;

function scrubHero() {
    pendingFrame = 0;
    const offset = header.offsetHeight - hero.getBoundingClientRect().top;
    const progress = Math.min(1, Math.max(0, offset / scrollDistance));
    video.currentTime = progress * Math.max(0, video.duration - 0.05);
}

function onScroll() {
    if (!pendingFrame) pendingFrame = requestAnimationFrame(scrubHero);
}

function syncHero() {
    const animated = eventId === "invicta" && !motion.matches;
    if (animated && !video.hasAttribute("src")) {
        video.preload = "metadata";
        video.src = video.dataset.src;
    }
    if (!animated && video.hasAttribute("src")) {
        video.removeAttribute("src");
        video.load();
    }
    if (!animated) {
        hero.classList.remove("has-scrub");
        window.removeEventListener("scroll", onScroll);
        cancelAnimationFrame(pendingFrame);
        pendingFrame = 0;
    }
}

video.addEventListener("loadedmetadata", () => {
    if (motion.matches || !Number.isFinite(video.duration)) return;
    hero.style.setProperty("--hero-scroll", scrollDistance + "px");
    hero.classList.add("has-scrub");
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
});
motion.addEventListener("change", syncHero);
syncHero();
