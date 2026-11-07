import { api, element, message, action, button, requireUser } from "./api.js";
async function load() {
    const data = await api("/platform");
    const list = document.getElementById("organizations");
    list.replaceChildren();
    for (const org of data.organizations) {
        const form = element("form", null, "card stack");
        form.append(element("h2", org.name), element("p", org.mp_user_id ? "Conta de recebimento conectada" : "Recebimento pendente", "muted"));
        const label = element("label", "Comissão percentual"); label.htmlFor = "fee-" + org.id;
        const input = element("input"); input.id = label.htmlFor; input.name = "percentage"; input.type = "number"; input.min = 0; input.max = 20; input.step = 0.01; input.required = true;
        input.value = org.fee_bps === null ? "" : org.fee_bps / 100;
        const modeLabel = element("label", "Cobrança da comissão"); modeLabel.htmlFor = "mode-" + org.id;
        const mode = element("select"); mode.id = modeLabel.htmlFor; mode.name = "feeMode";
        mode.add(new Option("Descontada do organizador", "included", false, org.fee_mode === "included"));
        mode.add(new Option("Acrescentada ao comprador", "added", false, org.fee_mode === "added"));
        const save = element("button", "Salvar comissão", "button"); save.type = "submit";
        form.append(label, input, modeLabel, mode, save);
        action(form, async (values) => {
            await api("/platform/organizations/" + org.id, { method: "PATCH", body: { feeBps: Math.round(Number(values.percentage) * 100), feeMode: values.feeMode } });
            message("Comissão atualizada para novos pedidos."); await load();
        });
        list.append(form);
    }
    const failures = document.getElementById("failed-jobs");
    failures.replaceChildren();
    if (!data.failedJobs.length) failures.append(element("p", "Nenhuma falha pendente.", "muted"));
    for (const item of data.failedJobs) {
        const row = element("article", null, "card data-row");
        row.append(element("p", item.kind + " · " + item.last_error), button("Tentar novamente", async () => {
            await api("/platform/jobs/" + item.id + "/retry", { method: "POST" }); await load();
        }, true));
        failures.append(row);
    }
}
try {
    const user = await requireUser();
    if (user) { if (!user.platformOwner) throw new Error("Esta página é restrita ao administrador da plataforma."); await load(); }
} catch (error) { message(error.message, true); }
