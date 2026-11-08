import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const token = () => randomBytes(32).toString("base64url");
export const hash = (value) => createHash("sha256").update(value).digest("hex");

export function equal(a, b) {
    const first = Buffer.from(String(a));
    const second = Buffer.from(String(b));
    return first.length === second.length && timingSafeEqual(first, second);
}

function key(config) {
    if (!/^[a-f0-9]{64}$/i.test(config.encryptionKey)) throw new Error("Configure ENCRYPTION_KEY com 32 bytes hexadecimais.");
    return Buffer.from(config.encryptionKey, "hex");
}

export function ticketCode(id, config) {
    return "INV1." + id + "." + createHmac("sha256", key(config)).update("ticket:" + id).digest("base64url");
}

export function ticketId(code, config) {
    const match = /^INV1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(code);
    return match && equal(ticketCode(match[1], config), code) ? match[1] : null;
}

export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export function requireValue(condition, status, message) {
    if (!condition) throw new HttpError(status, message);
}
