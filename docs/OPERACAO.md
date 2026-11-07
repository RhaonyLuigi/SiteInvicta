# Ativação e operação

## Configuração necessária para a primeira venda

1. Crie um PostgreSQL gerenciado de produção e um banco separado para homologação. Copie a conexão com pooling e TLS para `DATABASE_URL`. Rode `npm run migrate` com as variáveis desse ambiente. Não execute o seed em produção.
2. Na hospedagem, configure `NODE_ENV=production`, `APP_URL=https://seu-dominio`, `PAYMENT_PROVIDER=mercadopago` e `PLATFORM_OWNER_EMAIL` com seu e-mail real. Use um e-mail protegido por autenticação em duas etapas no provedor de e-mail.
3. Gere `ENCRYPTION_KEY` com 32 bytes aleatórios em hexadecimal (64 caracteres). Guarde uma cópia protegida junto do procedimento de recuperação. A chave cifra os tokens dos organizadores e assina ingressos; alterá-la invalida os códigos existentes e impede a leitura dos tokens antigos.
4. Crie um remetente de e-mail no Resend, valide o domínio e configure `RESEND_API_KEY` e `EMAIL_FROM`. Teste recebimento, spam, link de uso único e acesso em outro aparelho. Links nunca aparecem na resposta da API; só são impressos no terminal de desenvolvimento.
5. Configure a aplicação de marketplace no Mercado Pago, conforme os passos abaixo. Use primeiro contas e credenciais de teste.
6. Gere chaves com `npm run push:keys`. Configure `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` e `VAPID_SUBJECT=mailto:seu-contato`. Guarde a chave privada. Teste uma notificação com o app fechado em um aparelho real.
7. Gere um `CRON_SECRET` aleatório longo e configure o agendamento de tarefas descrito abaixo.
8. Complete `privacidade.html` e `termos.html` com a identificação real do operador, atendimento, retenção e condições comerciais. Cada evento deve ter local, datas, capa, contato, classificação/regras de acesso e política de reembolso corretos. Informe no texto do evento qualquer comprovação exigida para categoria estudantil.
9. Entre com o e-mail administrador. Crie sua organização, conecte o recebedor por **Conectar Mercado Pago** e defina a comissão em **Administração da plataforma**. A comissão começa pendente; vendas pagas não são publicadas até sua definição.
10. Conclua a homologação abaixo. Depois selecione `MERCADOPAGO_ENV=production`, use as credenciais do ambiente correspondente e faça uma compra de pequeno valor e seu estorno antes de divulgar o evento.

As variáveis estão descritas em `.env.example`. Configure-as como segredos na hospedagem; não as envie ao GitHub. O front recebe apenas a chave pública VAPID e o estado da configuração.

## Mercado Pago

O adaptador usa **Checkout Pro pela API de preferências**, com `marketplace_fee`, OAuth do vendedor e split 1:1. Não substitua pelo endpoint Orders sem reavaliar a compatibilidade do split. Veja a [integração oficial](https://www.mercadopago.com.br/developers/pt/docs/split-payments/split-1-1/integration-configuration/integrate-marketplace).

- Cadastre o domínio e a URL de redirecionamento exata: `https://seu-dominio/api/payments/connect/callback`.
- Configure `MERCADOPAGO_CLIENT_ID`, `MERCADOPAGO_CLIENT_SECRET` e o segredo de assinatura em `MERCADOPAGO_WEBHOOK_SECRET`.
- Habilite notificações de **pagamentos**. A preferência envia `notification_url=https://seu-dominio/api/webhooks/mercadopago?org=<UUID da organização>`; preserve o parâmetro `org`. Se usar o simulador do painel, inclua um pagamento real de teste dessa organização e esse parâmetro.
- Use contas de teste distintas para integrador, vendedor e comprador, com os requisitos de OAuth e split do provedor. Conecte o vendedor pelo próprio painel da Invicta.
- `MERCADOPAGO_ENV=sandbox` escolhe `sandbox_init_point` e recusa webhook com `live_mode=true`. Produção exige o ambiente correspondente. Não misture contas, tokens e assinaturas.
- O checkout limita a uma parcela e exclui boleto. O provedor decide quais meios estão disponíveis para o recebedor. Nenhum dado de cartão passa pela API Invicta.
- A aprovação depende de assinatura HMAC, consulta independente do pagamento e correspondência de organização, conta, ambiente, valor e BRL. Parâmetros recebidos no retorno do checkout não aprovam o pedido.

A conciliação consulta `/v1/payments/search` por `external_reference`, conforme a [API de gestão de pagamentos](https://www.mercadopago.com.br/developers/pt/docs/subscriptions/additional-content/payment-management). Ela reconsulta pequenos lotes de pedidos com checkout dos últimos 180 dias, no máximo uma vez a cada dez minutos por pedido, priorizando os menos consultados. Em volume maior, aumente a capacidade do worker e monitore a defasagem; o webhook é o caminho principal.

## Hospedagem e tarefas

O repositório inclui `vercel.json`: build `npm run build`, estáticos em `dist/` e função em `api/index.js`. A função usa PostgreSQL externo. As migrações são uma etapa explícita de implantação; a função não altera o schema ao atender usuários.

O endereço antigo no GitHub Pages encaminha para `site-invicta.vercel.app` por `hosting.js`. GitHub Pages não executa a API Node. Se mudar o domínio principal, atualize esse encaminhamento junto das variáveis e URLs do Mercado Pago.

No estado sem banco/chave configurados, `/api/health` responde `ready:false` e o site informa que as vendas ainda não foram abertas. Em produção não existe botão que aprove pagamento local.

Para agendar na Vercel, use um plano compatível com o uso comercial e a frequência necessária, ou um agendador externo que suporte cabeçalho de autorização. O [Hobby é destinado a uso pessoal e não comercial](https://vercel.com/docs/plans/hobby); um agendador externo não altera essa condição da hospedagem. A configuração entregue não cria assinatura paga nem agenda tarefas automaticamente. A cada minuto, chame:

```http
GET /api/jobs
Authorization: Bearer <CRON_SECRET>
```

Não coloque o segredo na URL. Essa chamada expira reservas, remove sessões vencidas, registra lembretes, concilia pagamentos e processa e-mails, pushes e estornos. Há limite de tempo por execução para a função serverless. Tarefas pendentes permanecem na fila; chamadas futuras continuam o processamento. A fila usa lease, deduplicação e nova tentativa com atraso. Após oito falhas, o administrador pode corrigir a causa e reprocessar a tarefa em `plataforma.html`.

Também é possível hospedar como serviço Node: instale dependências, aplique migrações, faça o build e execute `npm start` com HTTPS no proxy. Nesse modo o processo chama a rotina a cada dez segundos. Dimensione um worker dedicado se a fila ou as consultas ao provedor crescerem. Para execução manual, `npm run jobs` processa um lote usando o mesmo ambiente.

## Homologação antes de divulgar

- Entrar por e-mail, consumir o link uma vez, sair e conferir remoção da carteira offline.
- Criar evento, lote e comissão; conferir total e taxa antes de reservar. Alterar o preço depois da reserva não muda o pedido existente.
- Comprar pelo checkout real de teste, aguardar webhook, comparar o valor e a comissão no painel do provedor e receber o ingresso.
- Usar duas contas para tentar comprar a última vaga; confirmar que só uma reserva é aceita. Execute também `npm test` com `TEST_DATABASE_URL` de um banco de testes para testar várias conexões PostgreSQL.
- Ler o mesmo QR duas vezes, testar um código alterado e um código de outro evento. Uma conta de portaria não pode editar evento nem exportar participantes.
- Repetir o webhook; confirmar que a quantidade de ingressos permanece a mesma.
- Solicitar e aprovar um estorno integral. Confirmar o status no provedor, revogação do QR e aviso ao comprador. Se não houver saldo para estornar, corrigir no recebedor e reprocessar a tarefa.
- Cancelar um evento com venda e conferir os reembolsos. Testar um pagamento que chega depois da reserva sem capacidade: ele não pode emitir ingresso e deve ser devolvido.
- Interromper uma notificação de teste e confirmar recuperação pela conciliação. Testar a rotina agendada e um erro de envio recuperável.
- Instalar no Android e iPhone compatível, ativar notificações por gesto do usuário, fechar o app e receber um aviso. Acessar um ingresso online e depois consultá-lo offline.

Os testes automatizados usam banco e provedor controlados. A integração externa e o dispositivo físico dependem das suas contas; não foram homologados com credenciais reais nesta entrega.

## Rotina e recuperação

Monitore disponibilidade do site/API, erros HTTP, estoque, pedidos sem confirmação, fila e solicitações de reembolso. Confira valores também no relatório do provedor: o painel Invicta mostra pagamentos confirmados e taxas informadas; não é um extrato bancário nem a apuração do lucro do evento.

Configure backups automáticos e teste restauração em um banco separado antes de vender. Recupere banco e a mesma `ENCRYPTION_KEY`, sem sobrescrever produção durante o ensaio. Após restaurar um backup antigo, concilie pagamentos, estornos e entradas com os registros do provedor e da portaria antes de reabrir. Retenção, atendimento e tratamento de contestações precisam de um responsável definido.

O sistema processa reembolso integral por pedido. Faça estornos pelo painel Invicta; estornos parciais feitos diretamente no provedor não distribuem automaticamente cancelamento por ingresso. Cartões podem sofrer contestação posteriormente; os eventos de `charged_back` revogam os códigos quando recebidos ou conciliados. Não registre dados pessoais ou credenciais em logs públicos.
