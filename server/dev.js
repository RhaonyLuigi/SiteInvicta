import express from "express";
import { config, db, runtime } from "./runtime.js";
import { migrate } from "./db.js";
import { build } from "../scripts/build.js";

if (db && !config.production) await migrate(db);
await build();
runtime.app.use((req, res, next) => {
    res.set({
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(self \"https://js.stripe.com\" \"https://hooks.stripe.com\")",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' https://js.stripe.com; style-src 'self'; img-src 'self' data: https:; media-src 'self'; font-src 'self'; connect-src 'self' https://*.stripe.com https://*.stripe.network; worker-src 'self' blob:; frame-src https://js.stripe.com https://hooks.stripe.com https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
    });
    next();
});
runtime.app.use(express.static("dist", { dotfiles: "deny", setHeaders(res, path) {
    if (path.endsWith("sw.js")) res.setHeader("Cache-Control", "no-cache");
} }));
const server = runtime.app.listen(config.port, config.production ? "0.0.0.0" : "127.0.0.1", () => {
    console.log("Invicta em " + config.url);
    if (!config.production) console.log("Modo local. Links de acesso são enviados ao terminal. Pagamentos locais são identificados na conta.");
});
let running = false;
const timer = setInterval(async () => {
    if (!db || running) return;
    running = true;
    try {
        await runtime.tasks();
    } catch (error) {
        console.error("[Jobs]", error.message);
    } finally {
        running = false;
    }
}, 10000);
timer.unref();
process.on("SIGINT", async () => {
    clearInterval(timer);
    server.close();
    await db?.close();
    process.exit(0);
});
