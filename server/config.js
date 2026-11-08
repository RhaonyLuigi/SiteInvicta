export function configuration(overrides = {}) {
    const production = process.env.NODE_ENV === "production";
    const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    const url = process.env.APP_URL || (production ? "https://" + (vercelHost || "site-invicta.vercel.app") : "http://localhost:3000");
    const config = {
        production,
        url: new URL(url).origin,
        port: Number(process.env.PORT || 3000),
        databaseUrl: process.env.DATABASE_URL || "",
        localPath: process.env.LOCAL_DATABASE_PATH || ".data/postgres",
        paymentProvider: production ? "stripe" : (process.env.PAYMENT_PROVIDER || "mock"),
        ownerEmail: (process.env.PLATFORM_OWNER_EMAIL || "").toLowerCase(),
        feeBps: process.env.PLATFORM_FEE_BPS === undefined || process.env.PLATFORM_FEE_BPS === ""
            ? null : Number(process.env.PLATFORM_FEE_BPS),
        feeMode: process.env.PLATFORM_FEE_MODE || "included",
        encryptionKey: process.env.ENCRYPTION_KEY || "",
        resendKey: process.env.RESEND_API_KEY || "",
        emailFrom: process.env.EMAIL_FROM || "",
        vapidSubject: process.env.VAPID_SUBJECT || "",
        vapidPublic: process.env.VAPID_PUBLIC_KEY || "",
        vapidPrivate: process.env.VAPID_PRIVATE_KEY || "",
        cronSecret: process.env.CRON_SECRET || "",
        stripeSecret: process.env.STRIPE_SECRET_KEY || "",
        stripePublic: process.env.STRIPE_PUBLISHABLE_KEY || "",
        stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
        stripeProduction: process.env.STRIPE_ENV === "production",
        ...overrides
    };
    if (!["mock", "stripe"].includes(config.paymentProvider) || (config.production && (new URL(config.url).protocol !== "https:" || config.paymentProvider === "mock"))) {
        throw new Error("Produção requer HTTPS e um provedor de pagamento real.");
    }
    if (config.feeBps !== null && (!Number.isInteger(config.feeBps) || config.feeBps < 0 || config.feeBps > 2000)) {
        throw new Error("PLATFORM_FEE_BPS deve ser vazio ou um inteiro entre 0 e 2000.");
    }
    return config;
}
