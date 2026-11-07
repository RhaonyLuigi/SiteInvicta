export async function api(path, options = {}) {
    const response = await fetch("/api" + path, {
        credentials: "same-origin",
        ...options,
        headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
        ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    const data = await response.json().catch(() => ({ message: "Não foi possível acessar o servidor." }));
    if (!response.ok) {
        const error = new Error(data.message || "Não foi possível concluir.");
        error.status = response.status;
        throw error;
    }
    return data;
}
export const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) / 100);
export const date = (value) => new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(new Date(value));
export const eventUrl = (event) => "/index.html?evento=" + encodeURIComponent(event.slug || event.id);
export const inputDate = (value) => new Date(new Date(value).getTime() - 3 * 3600000).toISOString().slice(0, 16);
export const isoDate = (value) => new Date(value + ":00-03:00").toISOString();

export function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
}
export function message(text, error = false, target = document.querySelector("[data-status]")) {
    if (!target) return;
    target.textContent = text;
    target.dataset.error = error;
    target.hidden = !text;
}
export function action(form, handler) {
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const buttons = [...form.querySelectorAll("button")];
        const disabled = buttons.map((button) => button.disabled);
        buttons.forEach((button) => button.disabled = true);
        message("Salvando…");
        try {
            await handler(Object.fromEntries(new FormData(form)), form);
        } catch (error) {
            message(error.message, true);
        } finally {
            buttons.forEach((button, index) => button.disabled = disabled[index]);
        }
    });
}
export function button(text, handler, secondary = false) {
    const node = element("button", text, secondary ? "button button-secondary" : "button");
    node.type = "button";
    node.addEventListener("click", async () => {
        node.disabled = true;
        try { await handler(); } catch (error) { message(error.message, true); }
        finally { node.disabled = false; }
    });
    return node;
}
export async function requireUser() {
    const { user } = await api("/me");
    if (!user) {
        location.assign("/conta.html?voltar=" + encodeURIComponent(location.pathname + location.search));
        return null;
    }
    return user;
}

export function quote(lot, event, quantity) {
    const subtotal = lot.price_cents * quantity;
    const fee = Math.round(subtotal * (event.fee_bps || 0) / 10000);
    return { subtotal, fee, total: event.fee_mode === "added" ? subtotal + fee : subtotal };
}
