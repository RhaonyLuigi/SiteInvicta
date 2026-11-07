// Dados de demonstração compartilhados pelas três telas deste navegador.
const storageKey = "invicta-demo-v1";
const initialState = {
    events: [
        { id: "invicta", name: "A Maior da UCB", date: "2026-11-12T22:00", place: "Arena Hall · SCS, Brasília",
            description: "Uma noite para encontrar sua galera, curtir o open bar e viver a Invicta." },
        { id: "calourada", name: "Calourada", date: "2026-11-20T21:00", place: "Brasília",
            description: "Evento de exemplo para testar a seleção da portaria." }
    ],
    lots: [
        { id: "aluno", eventId: "invicta", name: "1º lote", category: "Aluno UCB", price: 5000, capacity: 100,
            description: "Pista premium, open bar universitário e copo exclusivo Invicta.", closed: false },
        { id: "geral", eventId: "invicta", name: "1º lote", category: "Público Geral", price: 8000, capacity: 100,
            description: "Pista premium e open bar completo.", closed: false }
    ],
    orders: [],
    tickets: [
        { code: "INV-001", eventId: "invicta", label: "Aluno UCB", usedAt: null },
        { code: "INV-002", eventId: "invicta", label: "Aluno UCB", usedAt: "2026-11-12T22:15:00-03:00" },
        { code: "INV-OUTRO", eventId: "calourada", label: "Público Geral", usedAt: null }
    ]
};

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const eventDate = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeStyle: "short" });

export const money = (cents) => currency.format(cents / 100);
export const formatEventDate = (value) => eventDate.format(new Date(value));

export function readDemo() {
    const stored = localStorage.getItem(storageKey);
    return stored ? JSON.parse(stored) : structuredClone(initialState);
}

export function saveDemo(state) {
    localStorage.setItem(storageKey, JSON.stringify(state));
}

export function soldCount(state, lotId) {
    return state.orders
        .filter((order) => order.lotId === lotId && order.status === "approved")
        .reduce((total, order) => total + order.quantity, 0);
}

export function availability(state, lot) {
    return Math.max(0, lot.capacity - soldCount(state, lot.id));
}

export function eventUrl(page, eventId) {
    return page + "?" + new URLSearchParams({ evento: eventId });
}

export function createOrder(eventId, lotId, quantity) {
    const state = readDemo();
    const lot = state.lots.find((item) => item.id === lotId && item.eventId === eventId);
    if (!lot || lot.closed) throw new Error("Este lote está encerrado.");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 5 || quantity > availability(state, lot)) {
        throw new Error("A quantidade escolhida está indisponível.");
    }
    const order = { id: crypto.randomUUID(), eventId, lotId, quantity, price: lot.price, status: "pending" };
    state.orders.push(order);
    saveDemo(state);
    return order;
}

export function resolveOrder(orderId, status) {
    const state = readDemo();
    const order = state.orders.find((item) => item.id === orderId);
    if (!order || order.status !== "pending") throw new Error("Este pedido já foi processado.");
    const tickets = [];
    if (status === "approved") {
        const lot = state.lots.find((item) => item.id === order.lotId);
        if (!lot || lot.closed || availability(state, lot) < order.quantity) {
            order.status = "declined";
            saveDemo(state);
            return { tickets, message: "A quantidade escolhida ficou indisponível. Revise seu pedido." };
        }
        for (let index = 0; index < order.quantity; index++) {
            tickets.push({
                code: "INV-" + crypto.randomUUID().toUpperCase(),
                orderId,
                eventId: order.eventId,
                label: lot.category,
                usedAt: null
            });
        }
        state.tickets.push(...tickets);
    }
    order.status = status;
    saveDemo(state);
    return { tickets, message: status === "approved" ? "Pagamento de teste aprovado. Seus ingressos estão abaixo." : "Pagamento de teste recusado. Você pode tentar de novo." };
}

export function checkIn(eventId, code) {
    const state = readDemo();
    const ticket = state.tickets.find((item) => item.code === code.trim().toUpperCase());
    if (!ticket) return { result: "invalid" };
    if (ticket.eventId !== eventId) return { result: "other-event" };
    if (ticket.usedAt) return { result: "used", ticket };
    ticket.usedAt = new Date().toISOString();
    saveDemo(state);
    return { result: "accepted", ticket };
}
