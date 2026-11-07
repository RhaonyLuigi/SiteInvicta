let installPrompt;
let registration;
if ("serviceWorker" in navigator) {
    registration = navigator.serviceWorker.register("/sw.js").catch(() => null);
}
window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    window.dispatchEvent(new Event("invicta-install-ready"));
});
export function standalone() {
    return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}
export async function install() {
    if (installPrompt) {
        await installPrompt.prompt();
        const result = await installPrompt.userChoice;
        installPrompt = undefined;
        return result.outcome === "accepted" ? "Aplicativo instalado." : "Você pode instalar depois.";
    }
    return "No menu do navegador, escolha Instalar aplicativo ou Compartilhar → Adicionar à Tela de Início.";
}
export async function subscribe(publicKey) {
    if (!("PushManager" in window) || !("Notification" in window)) throw new Error("Este navegador oferece acesso pelo site. Para notificações no iPhone, instale o app na Tela de Início.");
    if (!publicKey) throw new Error("As notificações serão liberadas após a configuração do serviço.");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("A permissão de notificações está desativada neste aparelho.");
    await registration;
    const worker = await navigator.serviceWorker.ready;
    const key = publicKey.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(key.padEnd(Math.ceil(key.length / 4) * 4, "=")), (character) => character.charCodeAt(0));
    return worker.pushManager.getSubscription().then((current) => current || worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes }));
}
export async function unsubscribe() {
    await registration;
    const worker = await navigator.serviceWorker.getRegistration();
    const current = await worker?.pushManager.getSubscription();
    if (current) await current.unsubscribe();
    return current?.endpoint;
}
function walletDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("invicta-wallet", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("snapshots");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
export async function offlineWallet(value) {
    const db = await walletDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction("snapshots", value === undefined ? "readonly" : "readwrite");
            const store = tx.objectStore("snapshots");
            const request = value === undefined ? store.get("wallet") : value === null ? store.delete("wallet") : store.put(value, "wallet");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } finally { db.close(); }
}
