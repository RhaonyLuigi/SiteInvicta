import { eventUrl, formatEventDate, money, readDemo, saveDemo, soldCount } from "./demo-store.js";

const byId = (id) => document.getElementById(id);
const events = byId("admin-events");
const eventSelect = byId("event-select");
const status = byId("admin-status");

function render() {
    try {
        const state = readDemo();
        const sales = state.orders.filter((order) => order.status === "approved");
        byId("revenue").textContent = money(sales.reduce((sum, order) => sum + order.price * order.quantity, 0));
        byId("sales").textContent = sales.reduce((sum, order) => sum + order.quantity, 0);
        byId("entries").textContent = state.tickets.filter((ticket) => ticket.orderId && ticket.usedAt).length;

        const selected = eventSelect.value;
        eventSelect.replaceChildren();
        events.replaceChildren();
        for (const event of state.events) {
            eventSelect.add(new Option(event.name, event.id, false, event.id === selected));
            const row = byId("event-row").content.cloneNode(true);
            row.querySelector("h3").textContent = event.name;
            row.querySelector("[data-event-meta]").textContent = formatEventDate(event.date) + " · " + event.place;
            const link = row.querySelector("a");
            link.href = eventUrl("index.html", event.id);
            link.setAttribute("aria-label", "Ver página de " + event.name);
            const lotList = row.querySelector("ul");
            for (const lot of state.lots.filter((item) => item.eventId === event.id)) {
                const item = byId("lot-row").content.cloneNode(true);
                const label = lot.name + " · " + lot.category;
                item.querySelector("strong").textContent = label;
                item.querySelector("p").textContent = [
                    money(lot.price), soldCount(state, lot.id) + "/" + lot.capacity + " vendidos",
                    lot.closed ? "Encerrado" : "Aberto"
                ].join(" · ");
                const button = item.querySelector("button");
                button.textContent = lot.closed ? "Reabrir lote" : "Encerrar lote";
                button.setAttribute("aria-label", button.textContent + " " + label);
                button.dataset.lotId = lot.id;
                button.addEventListener("click", () => toggleLot(lot.id));
                lotList.append(item);
            }
            if (!lotList.children.length) {
                const empty = document.createElement("li");
                empty.textContent = "Nenhum lote cadastrado.";
                lotList.append(empty);
            }
            events.append(row);
        }
    } catch {
        status.textContent = "Não foi possível abrir os dados de demonstração.";
    }
}

function saveForm(event, addRecord) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    for (const key of Object.keys(data)) data[key] = data[key].trim();
    try {
        const state = readDemo();
        const { message, eventId } = addRecord(state, data);
        saveDemo(state);
        form.reset();
        render();
        eventSelect.value = eventId;
        status.textContent = message;
    } catch (error) {
        status.textContent = error.message;
    }
}

byId("event-form").addEventListener("submit", (event) => saveForm(event, (state, data) => {
    if (!data.name || !data.place) throw new Error("Preencha o nome e o local do evento.");
    const id = crypto.randomUUID();
    state.events.push({ ...data, id });
    return { message: "Evento de teste salvo. Você já pode adicionar um lote.", eventId: id };
}));

byId("lot-form").addEventListener("submit", (event) => saveForm(event, (state, data) => {
    if (!data.name || !data.category) throw new Error("Preencha o nome do lote e a categoria.");
    if (!state.events.some((item) => item.id === data.eventId)) throw new Error("Escolha um evento.");
    state.lots.push({
        ...data, id: crypto.randomUUID(), price: Math.round(Number(data.price) * 100),
        capacity: Number(data.capacity), closed: false
    });
    return { message: "Lote de teste salvo.", eventId: data.eventId };
}));

function toggleLot(lotId) {
    try {
        const state = readDemo();
        const lot = state.lots.find((item) => item.id === lotId);
        lot.closed = !lot.closed;
        saveDemo(state);
        render();
        [...events.querySelectorAll("button")].find((item) => item.dataset.lotId === lotId)?.focus();
        status.textContent = lot.closed ? "Lote encerrado na demonstração." : "Lote reaberto na demonstração.";
    } catch {
        status.textContent = "Não foi possível atualizar este lote.";
    }
}

window.addEventListener("storage", render);
render();
