export async function tasks(db, config, provider, store, delivery) {
    const started = Date.now();
    await store.maintenance();
    let reconciled = 0;
    if (config.paymentProvider !== "mock" && provider.search) {
        const { rows } = await db.query(`
            SELECT o.id,o.payment_provider,e.org_id,g.stripe_account_id AS collector_id FROM orders o
            JOIN events e ON e.id=o.event_id JOIN organizations g ON g.id=e.org_id
            WHERE o.payment_provider='stripe' AND EXISTS(SELECT 1 FROM checkout_sessions s WHERE s.order_id=o.id) AND o.created_at>now()-interval '180 days'
            AND (o.reconciled_at IS NULL OR o.reconciled_at<now()-interval '10 minutes')
            ORDER BY o.reconciled_at NULLS FIRST,o.created_at DESC LIMIT 3`);
        for (const order of rows) {
            if (Date.now() - started > 15000) break;
            // Faz uma reserva curta para evitar duas rotinas consultando o mesmo pedido.
            const { rows: claimed } = await db.query(`UPDATE orders SET reconciled_at=now() WHERE id=$1
                AND (reconciled_at IS NULL OR reconciled_at<now()-interval '10 minutes') RETURNING id`, [order.id]);
            if (!claimed.length) continue;
            try {
                const results = await provider.search(order.org_id, order.id, order.payment_provider);
                for (const payment of results) {
                    if (payment.orderId === order.id && payment.collectorId === order.collector_id && payment.live === Boolean(config.stripeProduction)) {
                        await store.applyPayment(order.org_id, payment);
                    }
                }
                reconciled++;
            } catch (error) { console.error("[Conciliação]", order.id, error.message); }
        }
    }
    return { reconciled, processed: await delivery.run(100, Math.max(0, 50000 - (Date.now() - started))) };
}
