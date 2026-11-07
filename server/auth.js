import { Router } from "express";
import { z } from "zod";
import { token, hash, requireValue } from "./security.js";
import { job } from "./notifications.js";

export function authRouter(db, config, delivery) {
    const router = Router();
    const emailSchema = z.object({
        email: z.email().max(254).transform((value) => value.toLowerCase()),
        name: z.string().trim().min(2).max(80),
        returnTo: z.string().max(1000).optional().refine((value) => !value || (value.startsWith("/") && !value.startsWith("//")), "Destino inválido.")
    });
    router.post("/request", async (req, res) => {
        const { email, name, returnTo } = emailSchema.parse(req.body);
        const link = new URL("/conta.html", config.url);
        if (returnTo) link.searchParams.set("voltar", returnTo);
        requireValue(!config.production || (config.resendKey && config.emailFrom), 503, "O envio de e-mail precisa ser configurado.");
        const emailKey = hash("email:" + email + ":" + Math.floor(Date.now() / 900000));
        const { rows: [rate] } = await db.query("INSERT INTO rate_limits(key,expires_at) VALUES($1,now()+interval '30 minutes') ON CONFLICT(key) DO UPDATE SET hits=rate_limits.hits+1 RETURNING hits", [emailKey]);
        requireValue(rate.hits <= 5, 429, "Aguarde alguns minutos antes de solicitar outro link.");
        const secret = token();
        await db.query("INSERT INTO login_links(token_hash,email,name,expires_at) VALUES($1,$2,$3,now()+interval '15 minutes')", [hash(secret), email, name]);
        await job(db, "email", "login:" + hash(secret), { email, subject: "Seu acesso à Invicta",
            text: "Abra este link para entrar. Ele vale por 15 minutos e pode ser usado uma vez.\n\n" + link.href + "#acesso=" + secret });
        const delivered = await delivery.run(1, Infinity, "login:" + hash(secret));
        requireValue(delivered, 503, "Não foi possível enviar o link agora. Tente novamente em instantes.");
        res.json({ message: "Enviamos o link de acesso para seu e-mail. Confira também a caixa de spam." });
    });
    router.post("/verify", async (req, res) => {
        const input = z.object({ token: z.string().min(30).max(200) }).parse(req.body);
        const session = token();
        const user = await db.transaction(async (client) => {
            const { rows: [link] } = await client.query(
                "UPDATE login_links SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING *", [hash(input.token)]
            );
            requireValue(link, 401, "Este link expirou ou já foi utilizado. Solicite outro.");
            const { rows: [person] } = await client.query(
                "INSERT INTO users(email,name) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING *", [link.email, link.name]
            );
            await client.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')", [hash(session), person.id]);
            return person;
        });
        res.cookie("invicta_session", session, { httpOnly: true, secure: config.production, sameSite: "lax", maxAge: 30 * 86400000, path: "/" });
        res.json({ user: { ...user, platformOwner: user.email === config.ownerEmail } });
    });
    router.post("/logout", async (req, res) => {
        if (req.sessionHash) await db.query("DELETE FROM sessions WHERE token_hash=$1", [req.sessionHash]);
        res.clearCookie("invicta_session", { httpOnly: true, secure: config.production, sameSite: "lax", path: "/" });
        res.json({ ok: true });
    });
    return router;
}

export async function identify(req, db, config) {
    const raw = String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith("invicta_session="))?.slice(16);
    if (!raw || raw.length > 200) return;
    const sessionHash = hash(raw);
    const { rows: [user] } = await db.query(
        "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()", [sessionHash]
    );
    if (user) {
        req.user = { ...user, platformOwner: user.email === config.ownerEmail };
        req.sessionHash = sessionHash;
    }
}

export function authenticated(req, res, next) {
    requireValue(req.user, 401, "Entre na sua conta para continuar.");
    next();
}
