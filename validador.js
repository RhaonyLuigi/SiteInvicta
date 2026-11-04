import QrScanner from "./vendor/qr-scanner.min.js";
import { checkIn, readDemo } from "./demo-store.js";

const byId = (id) => document.getElementById(id);
const input = byId("ticket-code");
const events = byId("validation-event");
const preview = byId("scanner-preview");
const cameraButton = byId("camera-button");
const cameraStatus = byId("camera-status");
const resultPanel = byId("validation-result");
const next = byId("next-ticket");
const requestedEvent = new URLSearchParams(location.search).get("evento");
const dateFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
let scanner;

function loadEvents() {
    try {
        const selected = events.value || requestedEvent;
        events.replaceChildren();
        for (const event of readDemo().events) {
            events.add(new Option(event.name, event.id, false, event.id === selected));
        }
    } catch {
        showResult("error", "Dados indisponíveis", "Não foi possível abrir a demonstração neste navegador.");
    }
}

function showResult(result, title, details) {
    resultPanel.dataset.result = result;
    byId("result-title").textContent = title;
    byId("result-details").textContent = details;
    resultPanel.hidden = false;
    next.hidden = false;
}

function validate(code) {
    stopCamera();
    try {
        const { result, ticket } = checkIn(events.value, code);
        if (result === "accepted") {
            showResult(result, "Acesso permitido", ticket.label + " · entrada de teste registrada.");
        } else if (result === "used") {
            showResult(result, "Ingresso já utilizado", "Entrada registrada em " + dateFormat.format(new Date(ticket.usedAt)) + ".");
        } else if (result === "other-event") {
            showResult(result, "Ingresso de outro evento", "Confira o evento selecionado para esta portaria.");
        } else {
            showResult(result, "Ingresso inválido", "Confira o código e tente novamente.");
        }
    } catch {
        showResult("error", "Validação indisponível", "Confira o acesso aos dados deste navegador e tente novamente.");
    }
    next.focus();
}

function stopCamera() {
    scanner?.destroy();
    scanner = undefined;
    preview.hidden = true;
    cameraButton.textContent = "Abrir câmera";
    cameraStatus.textContent = "";
}

async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
        cameraStatus.textContent = "A câmera requer uma página segura e um navegador compatível. Digite o código para continuar.";
        return;
    }
    resultPanel.hidden = true;
    next.hidden = true;
    preview.hidden = false;
    cameraButton.textContent = "Fechar câmera";
    cameraStatus.textContent = "Aguardando a câmera.";
    const activeScanner = new QrScanner(preview, ({ data }) => validate(data), {
        preferredCamera: "environment",
        returnDetailedScanResult: true
    });
    scanner = activeScanner;
    try {
        await activeScanner.start();
        if (scanner === activeScanner) cameraStatus.textContent = "Aponte a câmera para o QR Code do ingresso.";
    } catch {
        if (scanner === activeScanner) {
            stopCamera();
            cameraStatus.textContent = "Não foi possível acessar a câmera. Verifique a permissão ou digite o código.";
        }
    }
}

cameraButton.addEventListener("click", () => {
    if (scanner) stopCamera();
    else startCamera();
});
byId("validation-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = input.value.trim();
    if (code) validate(code);
});
next.addEventListener("click", () => {
    resultPanel.hidden = true;
    next.hidden = true;
    input.value = "";
    input.focus();
});
window.addEventListener("pagehide", stopCamera);
window.addEventListener("storage", loadEvents);
loadEvents();
