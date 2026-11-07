import { configuration } from "../server/config.js";
import { database, migrate, localKey } from "../server/db.js";
const config = configuration();
if (config.production) throw new Error("Dados de exemplo são permitidos apenas no ambiente local.");
const db = await database(config);
await migrate(db);
await localKey(config);
await db.transaction(async (client) => {
    const { rows: [user] } = await client.query("INSERT INTO users(email,name) VALUES($1,'Organizador Invicta') ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id", [config.ownerEmail || "owner@invicta.test"]);
    const { rows: existing } = await client.query("SELECT id FROM organizations WHERE name='Atlética Invicta'");
    if (existing.length) return;
    const { rows: [org] } = await client.query("INSERT INTO organizations(name,fee_bps) VALUES('Atlética Invicta',NULL) RETURNING id");
    await client.query("INSERT INTO members(org_id,user_id,role) VALUES($1,$2,'owner')", [org.id,user.id]);
    const start = new Date(Date.now() + 7 * 86400000);
    const end = new Date(start.getTime() + 6 * 3600000);
    const { rows: [event] } = await client.query(`
        INSERT INTO events(org_id,slug,name,description,place,starts_at,ends_at,capacity,status,refund_policy)
        VALUES($1,'invicta','Encontro Invicta','Evento de exemplo para testar a plataforma localmente.','Brasília',$2,$3,200,'draft',
        'Evento local de exemplo. Solicitações de reembolso são analisadas pelo organizador no painel.') RETURNING id`, [org.id,start,end]);
    await client.query(`INSERT INTO lots(event_id,name,category,description,price_cents,capacity,sales_start,sales_end)
        VALUES($1,'Primeiro lote','Público geral','Acesso ao evento',5000,200,now(),$2)`, [event.id,start]);
});
await db.close();
console.log("Exemplo criado como rascunho. Entre com o e-mail do administrador, defina a comissão no painel da plataforma e publique.");
