# Ativação e operação

## Configuração inicial

1. Configure PostgreSQL com pooling em DATABASE_URL e aplique as migrações com npm run migrate antes de operar.
2. Configure NODE_ENV=production, APP_URL com o endereço HTTPS e PLATFORM_OWNER_EMAIL com seu e-mail. Produção usa Stripe como único provedor real.
3. Gere e preserve ENCRYPTION_KEY: ela assina os ingressos e não deve mudar quando o provedor for alterado. Configure Resend, remetente, VAPID e CRON_SECRET.
4. Siga [STRIPE.md](STRIPE.md) para conta da plataforma, contas conectadas, chaves, webhook, Pix, carteiras e homologação.
5. Crie a organização, configure recebimento e comissão, cadastre evento e lotes e conclua os testes antes da publicação comercial.

## Hospedagem e tarefas

O repositório inclui `vercel.json`: build `npm run build`, estáticos em `dist/` e função em `api/index.js`. A função usa PostgreSQL externo. As migrações são uma etapa explícita de implantação; a função não altera o schema ao atender usuários.

O endereço antigo no GitHub Pages encaminha para `site-invicta.vercel.app` por `hosting.js`. GitHub Pages não executa a API Node. Se mudar o domínio principal, atualize esse encaminhamento junto das variáveis, webhook e domínios de pagamento da Stripe.

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
