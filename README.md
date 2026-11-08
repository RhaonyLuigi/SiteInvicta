# Invicta

Venda de ingressos e gestão de eventos da Atlética Invicta de Biologia UCB. Site responsivo, aplicativo instalável (PWA), API Node.js e PostgreSQL.

O fluxo local funciona sem serviços pagos. O checkout no app usa Stripe Connect: Pix como primeira opção, cartões e Apple Pay/Google Pay quando disponíveis, com comissão automática. O adaptador Mercado Pago permanece para pedidos anteriores. Banco, e-mail, credenciais de pagamento, Web Push e agendamento precisam ser configurados na hospedagem para ativar a operação real. O servidor de produção recusa pagamentos simulados. Consulte [a ativação do Pix e das carteiras](docs/STRIPE.md).

## Rodar no computador

Requer Node.js 22 ou superior e npm. Na pasta do projeto:

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

Abra `http://localhost:3000`. O PostgreSQL de desenvolvimento é persistido em `.data/postgres` usando PGlite. O servidor aplica as migrações ao iniciar. A chave local de criptografia fica em `.data/encryption.key`. Não publique `.data` nem `.env`.

1. Entre em **Meus ingressos** com `owner@invicta.test` (o administrador definido no `.env`). O link de acesso aparece no terminal em desenvolvimento.
2. Em **Organizar**, crie uma organização e um evento. Cadastre um lote e a política de reembolso com contato da organização.
3. Em **Administração da plataforma**, defina a comissão dessa organização. Vazio significa pendente; zero é uma decisão explícita.
4. Publique o evento. Escolha um ingresso no site, reserve e use **Confirmar pagamento local** na conta para testar.
5. Na portaria, digite o código ou use a câmera. A segunda leitura informa que já houve entrada.

`npm run seed` cria opcionalmente uma organização e um evento de teste em rascunho. Ele só funciona em desenvolvimento. Encerre o servidor antes de executar outro processo que abra o mesmo banco PGlite.

## O que está implementado

- Acesso por link de e-mail de uso único, sessão em cookie HttpOnly e permissões por organização.
- Eventos em rascunho, publicação, pausa, edição, cancelamento e lotes por período, categoria, preço e capacidade.
- Reservas de 30 minutos na Stripe (15 no Mercado Pago/local), valores definidos no servidor, estoque transacional e repetição segura de pedidos.
- Cadastro do organizador pela Stripe Connect; cobrança na conta conectada e comissão automática configurável incluída ou acrescida. Mercado Pago mantém OAuth/PKCE e tokens criptografados.
- Confirmação por webhook assinado, conferência do pagamento no provedor, conciliação e emissão de QR Code assinado.
- Carteira de ingressos, consulta offline, instalação, avisos na conta, e-mail, Web Push e lembrete nas 24 horas anteriores.
- Equipe com funções de responsável, gestão e portaria; convites vinculados ao e-mail; exportação CSV de participantes.
- Check-in único, solicitações de reembolso, estorno integral em cancelamento e devolução de pagamentos duplicados ou sem vaga.
- Fila persistente com tentativas, recuperação após interrupção, tarefas com falha e reprocessamento pelo administrador da plataforma.

O QR é um ingresso ao portador: cada entrada deve apresentar um código diferente. O titular pode mostrar os códigos de seu pedido. Transferência nominal, assentos marcados, cupom, parcelamento, emissão fiscal e aplicativos de loja não fazem parte desta versão. O pagamento habilitado é por ingresso/lote de um evento e um organizador por pedido.

## Aplicativo e notificações

No Android, use **Instalar aplicativo** na conta ou o menu do navegador. No iPhone, abra no Safari e escolha **Compartilhar → Adicionar à Tela de Início**. Web Push no iPhone requer iOS/iPadOS 16.4 ou superior e o app adicionado à Tela de Início, conforme a [documentação do WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

Para ativar Web Push, gere as chaves com `npm run push:keys`, configure as três variáveis `VAPID_*` e ative notificações pelo botão na conta. Guarde a chave privada. A assinatura depende da permissão de cada aparelho. O app só salva a carteira após a conta ser acessada online; sair apaga a cópia offline. A portaria exige internet.

## Arquitetura para estudar

| Pasta | Responsabilidade |
| --- | --- |
| `server/app.js` | Rotas, validação, proteção de origem e integração dos módulos |
| `server/auth.js` | Links de acesso, sessões e identificação |
| `server/commerce.js` | Reserva, estoque, pagamento, ingresso e check-in |
| `server/organizers.js` | Organizações, equipe, eventos, lotes e reembolsos |
| `server/payments.js` | Adaptador Mercado Pago, OAuth e assinatura de webhook |
| `server/stripe.js` | Conta conectada, Pix/cartões no app, comissão, consulta e estorno Stripe |
| `client/checkout.js` | Formulário seguro Stripe e carteiras compatíveis |
| `server/notifications.js` | Fila de e-mails, pushes e estornos |
| `server/tasks.js` | Conciliação, expiração e processamento agendado |
| `db/` | Migrações SQL numeradas e registradas em `schema_migrations` |
| `client/` | API, conta, PWA e administração da plataforma |
| `api/index.js` | Entrada da função Node na Vercel |
| `scripts/` | Build, migração, exemplo local, tarefas e chaves Push |

O bloqueio da linha do evento serializa operações que alteram estoque. Os preços, a taxa e o prazo do pedido ficam registrados como eram na reserva. A URL de retorno do checkout não aprova um ingresso. O webhook consulta o provedor e valida valor, moeda, conta e ambiente antes da emissão. A carteira privada não entra no cache HTTP do service worker; a cópia offline é feita explicitamente em IndexedDB.

## Banco, pagamentos e ativação

Veja [a configuração atual da Stripe](docs/STRIPE.md), [as opções de provedores e custos](docs/PROVEDORES.md) e [o guia de ativação e operação](docs/OPERACAO.md). O banco continua PostgreSQL gerenciado. O provedor só muda após configurar as credenciais; o código não ativa uma conta financeira nem realiza pagamentos reais automaticamente.

```powershell
npm test
npm run build
npm run migrate
npm run jobs
```

`npm test` executa testes de integração HTTP com PostgreSQL embutido isolado em memória. Eles cobrem permissões, preço e idempotência, disputa de capacidade, emissão repetida, check-in repetido, pagamentos atrasados, cancelamentos, assinatura de webhook e envio de comissão. Para validar o mecanismo de bloqueio em várias conexões, também execute a suíte contra PostgreSQL com `TEST_DATABASE_URL` de um banco de testes. Não foram feitos pagamentos reais nem testes de carga de produção.

## Design e créditos

O visual aprovado do UI UX Pro Max foi restaurado: destaque verde, títulos grandes, formas arredondadas e cartões de ingresso. Os recursos de conta e gestão acompanham as cores originais. Os vídeos são horizontais, começam sem som e têm botão de pausa; o movimento reduzido do aparelho é respeitado.

O trabalho usa [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) e adapta orientações do [Unslop, criado por Damir Sokolovsky](https://github.com/heydamir/unslop), sob [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). A fotografia de atmosfera existente é ilustrativa, identificada no site; troque pela capa real ao publicar um evento. Fontes e bibliotecas são servidas pelo próprio projeto, com licenças em `assets/fonts/` e `vendor/`.

- [QR Code Generator 2.0.4](https://github.com/kazuhikoarase/qrcode-generator), MIT.
- [QR Scanner 1.4.2](https://github.com/nimiq/qr-scanner), MIT.
