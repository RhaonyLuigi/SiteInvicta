import { api, money, date, inputDate, isoDate, element, button, action, message, requireUser, eventUrl } from "./client/api.js";
import "./client/pwa.js";
const byId = (id) => document.getElementById(id);
const eventForm = byId("event-form");
const lotForm = byId("lot-form");
let data = { organizations: [], events: [] };
let summary;
let user;
const org = () => data.organizations.find((item) => item.id === byId("org-select").value);
const state = { draft: "Rascunho", published: "Publicado", closed: "Vendas pausadas", cancelled: "Cancelado", pending: "Aguardando análise", approved: "Aprovado", denied: "Recusado", owner: "Responsável", manager: "Gestão de eventos", checkin: "Portaria" };
function resetEvent() { eventForm.reset(); eventForm.elements.id.value = ""; }
function resetLot() { lotForm.reset(); lotForm.elements.id.value = ""; }
function fillEvent(event) {
    for (const key of ["name", "description", "place", "capacity"]) eventForm.elements[key].value = event[key];
    eventForm.elements.id.value = event.id;
    eventForm.elements.startsAt.value = inputDate(event.starts_at);
    eventForm.elements.endsAt.value = inputDate(event.ends_at);
    eventForm.elements.coverUrl.value = event.cover_url;
    eventForm.elements.refundPolicy.value = event.refund_policy;
    eventForm.scrollIntoView({ block: "start" });
}
function fillLot(lot) {
    for (const key of ["name", "category", "description", "capacity"]) lotForm.elements[key].value = lot[key];
    lotForm.elements.id.value = lot.id;
    lotForm.elements.eventId.value = lot.event_id;
    lotForm.elements.price.value = (lot.price_cents / 100).toFixed(2);
    lotForm.elements.salesStart.value = inputDate(lot.sales_start);
    lotForm.elements.salesEnd.value = inputDate(lot.sales_end);
    lotForm.elements.closed.checked = lot.closed;
    lotForm.scrollIntoView({ block: "start" });
}
async function load(selected) {
    data = await api("/manage");
    const select = byId("org-select");
    const value = selected || select.value;
    select.replaceChildren();
    for (const item of data.organizations) select.add(new Option(item.name, item.id, false, item.id === value));
    byId("manage").hidden = false;
    await render();
}
async function render() {
    const current = org();
    const canManage = current && current.role !== "checkin";
    byId("manager-tools").hidden = !canManage;
    byId("team-tools").hidden = !canManage;
    byId("refund-tools").hidden = !canManage;
    const select = byId("event-select");
    select.replaceChildren();
    const events = data.events.filter((item) => item.org_id === current?.id);
    for (const event of events) select.add(new Option(event.name, event.id));
    const list = byId("event-list");
    list.replaceChildren();
    if (!events.length) list.append(element("p", "Crie um evento para cadastrar seus lotes.", "muted"));
    for (const event of events) {
        const card = element("article", null, "card stack");
        card.append(element("h3", event.name), element("p", date(event.starts_at) + " · " + event.place, "muted"), element("p", state[event.status], "field-help"));
        const actions = element("div", null, "button-group");
        const scan = element("a", "Abrir portaria", "button button-secondary");
        scan.href = "/validador.html?evento=" + event.id;
        actions.append(scan);
        if (event.status !== "draft") { const link = element("a", "Página do evento", "button button-secondary"); link.href = eventUrl(event); actions.append(link); }
        if (canManage) {
            actions.append(button("Editar evento", () => fillEvent(event), true));
            for (const [label, status] of [["Publicar", "published"], ["Pausar vendas", "closed"], ["Cancelar evento", "cancelled"]]) {
                if (event.status === status || event.status === "cancelled") continue;
                actions.append(button(label, async () => {
                    if (status === "cancelled" && !confirm("Cancelar o evento e iniciar os reembolsos dos pedidos pagos?")) return;
                    await api("/manage/events/" + event.id + "/status", { method: "POST", body: { status } });
                    await load(current.id); message("Evento atualizado.");
                }, true));
            }
            const exportLink = element("a", "Exportar participantes", "button button-secondary");
            exportLink.href = "/api/manage/events/" + event.id + "/participants.csv";
            actions.append(exportLink);
        }
        card.append(actions);
        const lots = data.lots.filter((lot) => lot.event_id === event.id);
        for (const lot of lots) {
            const row = element("div", null, "data-row");
            row.append(element("span", lot.name + " · " + lot.category + " · " + money(lot.price_cents)));
            if (canManage) row.append(button("Editar lote", () => fillLot(lot), true));
            card.append(row);
        }
        if (canManage && event.status !== "draft") {
            const details = element("details");
            details.append(element("summary", "Enviar aviso aos participantes"));
            const form = element("form", null, "stack");
            const title = element("input"); title.name = "title"; title.required = true; title.minLength = 3; title.maxLength = 100; title.id = "title-" + event.id;
            const body = element("textarea"); body.name = "body"; body.required = true; body.minLength = 5; body.maxLength = 1000; body.id = "body-" + event.id;
            const labelTitle = element("label", "Assunto"); labelTitle.htmlFor = title.id;
            const labelBody = element("label", "Mensagem"); labelBody.htmlFor = body.id;
            const send = element("button", "Enviar aviso", "button"); send.type = "submit";
            form.append(labelTitle, title, labelBody, body, send);
            action(form, async (values) => {
                const result = await api("/manage/events/" + event.id + "/announcement", { method: "POST", body: { ...values, key: crypto.randomUUID() } });
                message("Aviso registrado para " + result.recipients + " participante(s)."); form.reset(); details.open = false;
            });
            details.append(form); card.append(details);
        }
        list.append(card);
    }
    if (!canManage) return;
    summary = await api("/manage/organizations/" + current.id);
    byId("sold").textContent = summary.summary.tickets;
    byId("gross").textContent = money(summary.summary.gross_cents);
    byId("net").textContent = money(Number(summary.summary.gross_cents) - Number(summary.summary.platform_cents) - Number(summary.summary.provider_cents));
    byId("receiving-status").textContent = (current.stripe_ready ? "Recebimento com Pix e cartões habilitado" : current.stripe_account_id ? "Cadastro de recebimento em análise ou incompleto" : "Cadastre a conta que receberá suas vendas pela Stripe");
    byId("commission-status").textContent = current.fee_bps === null ? "Comissão pendente de configuração pela plataforma." : "Comissão " + (current.fee_bps / 100).toFixed(2) + "% · " + (current.fee_mode === "added" ? "acrescida ao comprador" : "descontada do organizador");
    const receiving = byId("receiving-actions");
    receiving.replaceChildren();
    if (current.role === "owner") receiving.append(button("Configurar recebimento", async () => {
        const result = await api("/payments/stripe/onboard", { method: "POST", body: { orgId: current.id } });
        location.assign(result.url);
    }));
    if (current.stripe_account_id && current.role === "owner") receiving.append(button("Verificar cadastro", async () => {
        const result = await api("/payments/stripe/status", { method: "POST", body: { orgId: current.id } });
        await load(current.id); message(result.ready ? "Recebimento habilitado." : "Conclua o cadastro e habilite Pix no painel Stripe.");
    }, true));
    if (user.platformOwner) { const link = element("a", "Definir comissão", "button button-secondary"); link.href = "/plataforma.html"; receiving.append(link); }
    const team = byId("team-list"); team.replaceChildren();
    for (const person of summary.team) {
        const row = element("div", null, "data-row");
        row.append(element("span", person.name + " · " + person.email + " · " + state[person.role]));
        if (current.role === "owner" && person.role !== "owner") row.append(button("Remover acesso", async () => {
            await api("/manage/organizations/" + current.id + "/members/" + person.id, { method: "DELETE" }); await render();
        }, true));
        team.append(row);
    }
    byId("invite-form").hidden = current.role !== "owner";
    const refunds = byId("refund-list"); refunds.replaceChildren();
    if (!summary.refunds.length && !summary.pendingRefunds.length) refunds.append(element("p", "Nenhuma solicitação pendente.", "muted"));
    for (const request of summary.refunds) {
        const card = element("article", null, "card stack");
        card.append(element("h3", request.event_name), element("p", request.buyer + " · " + money(request.total_cents)), element("p", request.reason), element("p", state[request.status], "field-help"));
        if (request.status === "pending") {
            const text = element("textarea"); text.minLength = 5; text.maxLength = 500; text.id = "refund-" + request.id;
            const label = element("label", "Resposta ao comprador"); label.htmlFor = text.id;
            const choices = element("div", null, "button-group");
            for (const [title, approve] of [["Aprovar reembolso", true], ["Recusar solicitação", false]]) {
                choices.append(button(title, async () => {
                    if (text.value.trim().length < 5) { text.focus(); throw new Error("Escreva uma resposta para o comprador."); }
                    if (approve && !confirm("Confirmar o reembolso deste pedido?")) return;
                    await api("/manage/refunds/" + request.id, { method: "POST", body: { approve, reason: text.value } }); await render();
                }, !approve));
            }
            card.append(label, text, choices);
        }
        refunds.append(card);
    }
    for (const order of summary.pendingRefunds) refunds.append(element("p", order.name + " · Reembolso em processamento · " + order.id, "notice"));
}
action(byId("org-form"), async (values, form) => { const item = await api("/manage/organizations", { method: "POST", body: values }); form.reset(); await load(item.id); message("Organização criada."); });
action(eventForm, async (values) => {
    if (!org()) throw new Error("Crie uma organização primeiro.");
    const input = { name: values.name, description: values.description, place: values.place, startsAt: isoDate(values.startsAt), endsAt: isoDate(values.endsAt), capacity: Number(values.capacity), coverUrl: values.coverUrl, refundPolicy: values.refundPolicy };
    const path = values.id ? "/manage/events/" + values.id : "/manage/organizations/" + org().id + "/events";
    await api(path, { method: values.id ? "PUT" : "POST", body: input }); resetEvent(); await load(org().id); message("Evento salvo como rascunho ou atualização.");
});
action(lotForm, async (values) => {
    const input = { name: values.name, category: values.category, description: values.description, priceCents: Math.round(Number(values.price) * 100), capacity: Number(values.capacity), salesStart: isoDate(values.salesStart), salesEnd: isoDate(values.salesEnd), closed: values.closed === "on" };
    await api(values.id ? "/manage/lots/" + values.id : "/manage/events/" + values.eventId + "/lots", { method: values.id ? "PUT" : "POST", body: input });
    resetLot(); await load(org().id); message("Lote salvo.");
});
action(byId("invite-form"), async (values, form) => { const result = await api("/manage/organizations/" + org().id + "/invitations", { method: "POST", body: values }); message(result.message); form.reset(); });
byId("org-select").addEventListener("change", () => { resetEvent(); resetLot(); render().catch((error) => message(error.message, true)); });
byId("new-event").addEventListener("click", resetEvent);
byId("new-lot").addEventListener("click", resetLot);
try { user = await requireUser(); if (user) await load(); } catch (error) { message(error.message, true); }
