import QrScanner from "./vendor/qr-scanner.min.js";
import { api, requireUser, date, message } from "./client/api.js";
import "./client/pwa.js";
const byId = (id) => document.getElementById(id);
const input = byId("ticket-code");
const events = byId("validation-event");
const preview = byId("scanner-preview");
const camera = byId("camera-button");
let scanner;
let validating = false;
function stopCamera() {
    scanner?.destroy(); scanner = undefined; preview.hidden = true;
    camera.textContent = "Abrir câmera"; byId("camera-status").textContent = "";
}
async function validate(code) {
    if (validating) return;
    validating = true;
    stopCamera();
    const submit = document.querySelector("#validation-form button");
    submit.disabled = true;
    try {
        const result = await api("/checkin", { method: "POST", body: { eventId: events.value, code } });
        const titles = { accepted: "Acesso permitido", used: "Ingresso já utilizado", invalid: "Ingresso inválido", "other-event": "Ingresso de outro evento", cancelled: "Ingresso cancelado" };
        byId("result-title").textContent = titles[result.result];
        byId("result-details").textContent = result.result === "accepted" ? result.holder + " · " + result.category
            : result.checkedAt ? "Entrada registrada em " + date(result.checkedAt) : "Confira o evento e o código do ingresso.";
        byId("validation-result").dataset.result = result.result;
        byId("validation-result").hidden = false;
        byId("next-ticket").hidden = false;
        byId("next-ticket").focus();
    } catch (error) { message(navigator.onLine ? error.message : "Sem conexão. Aguarde o retorno da internet para validar.", true); }
    finally { validating = false; submit.disabled = false; }
}
byId("validation-form").addEventListener("submit", (event) => {
    event.preventDefault(); if (event.currentTarget.reportValidity()) validate(input.value.trim());
});
camera.addEventListener("click", async () => {
    if (scanner) return stopCamera();
    if (!events.value) return message("Escolha um evento.", true);
    if (!navigator.mediaDevices?.getUserMedia) return message("A câmera requer um navegador compatível e conexão segura. Você pode digitar o código.", true);
    preview.hidden = false; camera.textContent = "Fechar câmera";
    const active = new QrScanner(preview, ({ data }) => validate(data), { preferredCamera: "environment", returnDetailedScanResult: true });
    scanner = active;
    try { await active.start(); byId("camera-status").textContent = "Aponte para o QR Code."; }
    catch { if (scanner === active) { stopCamera(); message("A câmera não foi liberada. Confira a permissão ou digite o código.", true); } }
});
byId("next-ticket").addEventListener("click", () => { byId("validation-result").hidden = true; byId("next-ticket").hidden = true; input.value = ""; input.focus(); });
window.addEventListener("pagehide", stopCamera);
try {
    const user = await requireUser();
    if (user) {
        const data = await api("/manage");
        const selected = new URLSearchParams(location.search).get("evento");
        for (const event of data.events.filter((item) => item.status !== "draft")) events.add(new Option(event.name, event.id, false, event.id === selected));
        if (!events.length) message("Sua conta ainda não tem acesso a uma portaria. Peça um convite à organização.");
    }
} catch (error) { message(error.message, true); }
