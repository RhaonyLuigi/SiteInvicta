import { api, money, date, element, eventUrl, quote, message } from "./client/api.js";
import "./client/pwa.js";

let current;
let selectedLot;
let requestKey;
const checkout = document.getElementById("checkout");
const quantity = document.getElementById("quantity");
const status = document.getElementById("checkout-status");
const byId = (id) => document.getElementById(id);
function openCheckout(lot, event, count = 1) {
    selectedLot = lot;
    requestKey = crypto.randomUUID();
    byId("checkout-lot").textContent = event.name + " · " + lot.category;
    quantity.max = Math.min(10, lot.available);
    quantity.value = Math.min(Number(quantity.max), Math.max(1, count));
    updateQuote();
    message("", false, status);
    checkout.showModal();
    quantity.focus();
}

function showEvents(events) {
    const list = byId("event-list");
    list.replaceChildren();
    if (!events.length) list.append(element("p", "Nenhum evento disponível no momento.", "muted"));
    for (const event of events) {
        const card = element("article", null, "card event-card");
        const link = element("a");
        link.href = eventUrl(event);
        const image = element("img");
        image.src = event.cover_url;
        image.alt = "Capa de " + event.name;
        image.loading = "lazy";
        image.width = 640;
        image.height = 400;
        link.append(image, element("h3", event.name), element("p", date(event.starts_at), "muted"), element("p", event.place, "muted"));
        card.append(link);
        list.append(card);
    }
}
function showEvent(event) {
    current = event;
    byId("event-title").textContent = event.name;
    byId("event-organizer").textContent = event.organizer;
    byId("event-intro").textContent = event.description;
    byId("event-date").textContent = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: "America/Sao_Paulo" }).format(new Date(event.starts_at));
    byId("event-time").textContent = new Intl.DateTimeFormat("pt-BR", { timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(new Date(event.starts_at)) + " · Brasília";
    byId("event-when").dateTime = event.starts_at;
    byId("event-place").textContent = event.place;
    byId("event-address").hidden = true;
    byId("event-cover").src = event.cover_url;
    byId("cover-caption").hidden = !event.cover_url.includes("atmosfera-invicta");
    byId("event-facts").hidden = false;
    document.title = event.name + " | Invicta";
    byId("refund-policy").textContent = "Política do organizador · " + event.refund_policy;
    const prices = event.lots.filter((lot) => lot.sellable).map((lot) => lot.price_cents);
    byId("event-price").textContent = prices.length ? money(Math.min(...prices)) : "Vendas indisponíveis";
    byId("mobile-price").textContent = byId("event-price").textContent;
    byId("event-price-note").textContent = event.fee_mode === "added" ? "Mais taxa da plataforma" : "Preço inicial";
    const list = byId("ticket-list");
    list.replaceChildren();
    if (!event.lots.length) list.append(element("p", "Os lotes serão publicados pela organização.", "muted"));
    for (const lot of event.lots) {
        const card = byId("lot-card").content.firstElementChild.cloneNode(true);
        for (const [field, value] of Object.entries({ name: lot.name, category: lot.category, price: money(lot.price_cents), description: lot.description, availability: lot.available + " disponíveis" })) {
            card.querySelector("[data-lot-" + field + "]").textContent = value;
        }
        card.querySelector(".lot-unit").textContent = event.fee_mode === "added" ? "por pessoa + taxa da plataforma" : "por pessoa";
        const button = card.querySelector("button");
        button.textContent = lot.sellable ? "Escolher ingresso" : "Vendas indisponíveis";
        button.type = "button";
        button.disabled = !lot.sellable;
        button.addEventListener("click", () => openCheckout(lot, event));
        list.append(card);
    }
    byId("sales-note").textContent = event.status === "cancelled" ? "Evento cancelado. Consulte o pedido para acompanhar o reembolso." : "A disponibilidade é confirmada ao reservar seu pedido.";
}
function updateQuote() {
    if (!selectedLot || !quantity.validity.valid) return;
    const values = quote(selectedLot, current, quantity.valueAsNumber);
    byId("subtotal").textContent = money(values.subtotal);
    byId("fee-line").hidden = current.fee_mode !== "added";
    byId("fee").textContent = money(values.fee);
    byId("checkout-total").value = money(values.total);
}
quantity.addEventListener("input", updateQuote);
for (const control of document.querySelectorAll("[data-quantity-step]")) {
    control.addEventListener("click", () => {
        quantity.value = Math.min(Number(quantity.max), Math.max(1, (quantity.valueAsNumber || 1) + Number(control.dataset.quantityStep)));
        updateQuote();
    });
}
byId("checkout-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const button = byId("reserve-button");
    button.disabled = true;
    message("Reservando…", false, status);
    try {
        const { user } = await api("/me");
        if (!user) {
            try { sessionStorage.setItem("invicta-selection", JSON.stringify({ eventId: current.id, lotId: selectedLot.id, quantity: quantity.valueAsNumber })); } catch { /* O acesso também funciona sem armazenamento. */ }
            location.assign("/conta.html?voltar=" + encodeURIComponent(eventUrl(current)));
            return;
        }
        const order = await api("/orders", { method: "POST", body: { lotId: selectedLot.id, quantity: quantity.valueAsNumber, key: requestKey } });
        location.assign("/conta.html?pedido=" + order.id);
    } catch (error) {
        message(error.message, true, status);
    } finally { button.disabled = false; }
});
byId("search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try { showEvents((await api("/events?q=" + encodeURIComponent(byId("search").value))).events); }
    catch (error) { message(error.message, true); }
});

try {
    const health = await api("/health");
    if (health.reservationMinutes) byId("reservation-note").textContent = "Ao continuar, você reserva os ingressos por " + health.reservationMinutes + " minutos e confere o pagamento na sua conta.";
    if (!health.ready) {
        message(health.message);
        byId("sales-note").textContent = "As vendas serão abertas após a configuração da plataforma.";
    } else {
        const { events } = await api("/events");
        showEvents(events);
        const selected = new URLSearchParams(location.search).get("evento");
        if (selected) showEvent(await api("/events/" + encodeURIComponent(selected)));
        else if (events[0]) showEvent(events[0]);
        else byId("sales-note").textContent = "A organização publicará as próximas datas aqui.";
        try {
            const saved = JSON.parse(sessionStorage.getItem("invicta-selection") || "null");
            if (saved?.eventId === current?.id) {
                sessionStorage.removeItem("invicta-selection");
                const lot = current.lots.find((item) => item.id === saved.lotId && item.sellable);
                if (lot) openCheckout(lot, current, saved.quantity);
            }
        } catch { /* A seleção pode ser refeita na lista de lotes. */ }
    }
} catch (error) { message(error.message, true); }

const videos = [...document.querySelectorAll("video[data-src]")];
const toggle = byId("motion-toggle");
const motion = matchMedia("(prefers-reduced-motion: reduce)");
function syncToggle() {
    const playing = videos.some((video) => !video.paused);
    const label = playing ? "Pausar vídeos" : "Reproduzir vídeos";
    toggle.dataset.playing = playing;
    toggle.setAttribute("aria-label", label);
    byId("motion-label").textContent = label;
}
function playback(playing) {
    for (const video of videos) {
        if (playing) {
            if (!video.hasAttribute("src")) video.src = video.dataset.src;
            video.play().catch(syncToggle);
        } else video.pause();
    }
    syncToggle();
}
for (const video of videos) {
    video.addEventListener("playing", syncToggle);
    video.addEventListener("pause", syncToggle);
}
toggle.hidden = false;
toggle.addEventListener("click", () => playback(videos.every((video) => video.paused)));
motion.addEventListener("change", () => playback(!motion.matches));
playback(!motion.matches);

if ("IntersectionObserver" in window) {
    let heroVisible = true;
    let ticketsVisible = false;
    const purchaseObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.target.id === "hero") heroVisible = entry.isIntersecting;
            else ticketsVisible = entry.isIntersecting;
        }
        byId("mobile-purchase").hidden = !current?.lots.some((lot) => lot.sellable) || heroVisible || ticketsVisible || checkout.open;
    });
    purchaseObserver.observe(byId("hero"));
    purchaseObserver.observe(byId("ingressos"));
    if (!motion.matches) {
        const revealObserver = new IntersectionObserver((entries, observer) => {
            for (const entry of entries) if (entry.isIntersecting) {
                entry.target.classList.add("is-visible");
                observer.unobserve(entry.target);
            }
        }, { threshold: 0.08 });
        document.querySelectorAll(".reveal").forEach((item) => revealObserver.observe(item));
        document.documentElement.classList.add("motion-ready");
    }
}
