# Ativar Pix e pagamento no aplicativo

O novo fluxo usa Stripe Connect com cobrança direta na conta conectada do organizador e `application_fee_amount` para a comissão da plataforma. O Pix aparece primeiro; cartões ficam na segunda opção, junto das carteiras digitais compatíveis. O formulário seguro é carregado da Stripe dentro da Invicta. Para confirmar um Pix, o comprador precisa abrir o aplicativo de seu banco; autenticação de cartão também pode exigir uma etapa do emissor.

## 1. Sua conta da plataforma

Crie sua conta brasileira em https://dashboard.stripe.com/register e configure Connect para uma plataforma que vende ingressos para organizadores. Complete pessoalmente a identificação, dados bancários e termos pedidos pela Stripe. Confirme no painel/suporte que sua atividade, seu modelo de comissão e as contas conectadas brasileiras podem usar Pix. Pix está sujeito à elegibilidade e à categoria do negócio: não classifique a atividade como outra para contornar restrições. Não abra vendas antes dessa confirmação.

O código cria contas conectadas Standard brasileiras, com painel próprio. O organizador conclui o cadastro hospedado pela Stripe e informa sua conta bancária lá. Não basta cadastrar uma chave Pix arbitrária: recebimento dividido exige a identificação e aprovação do recebedor. O organizador recebe o saldo após a comissão da plataforma e as taxas do provedor, segundo o prazo de repasse da Stripe. Sua comissão chega ao saldo da conta da plataforma.

## 2. Chaves de teste na Vercel

No ambiente de teste da Stripe, copie a chave publicável `pk_test_...` e a chave secreta `sk_test_...`. Em Vercel → projeto SiteInvicta → Settings → Environment Variables, configure:

```dotenv
PAYMENT_PROVIDER=stripe
STRIPE_ENV=test
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
APP_URL=https://site-invicta.vercel.app
```

O `whsec_...` é gerado no próximo passo. Mantenha `NODE_ENV=production`, o banco, a chave de criptografia, Resend e o segredo de jobs já configurados. Não publique chaves em commits, capturas ou mensagens. Não use as contas ou cartões de teste do Mercado Pago na Stripe. Configure primeiro todas as variáveis e então faça um novo deploy.

## 3. Webhook de contas conectadas

No painel Stripe, crie um destino de webhook para **eventos de contas conectadas (Connect)**, no mesmo ambiente das chaves. Destino:

`https://site-invicta.vercel.app/api/webhooks/stripe`

Selecione os eventos abaixo e use o formato de eventos com objeto completo (snapshot, API v1):

```text
account.updated
payment_intent.succeeded
payment_intent.payment_failed
charge.refunded
charge.dispute.created
checkout.session.completed
checkout.session.async_payment_succeeded
```

Copie o segredo de assinatura desse destino para `STRIPE_WEBHOOK_SECRET`. O endpoint verifica a assinatura dos bytes originais, o ambiente e a conta conectada. Consulta novamente o pagamento na Stripe e confere o pedido, valor e moeda antes de emitir o ingresso. A página de retorno nunca aprova uma compra por conta própria.

## 4. Organizador e comissão

Entre na Invicta → Organizar → selecione sua organização → **Configurar recebimento**. Complete o cadastro Stripe. Volte à Invicta e clique em **Verificar cadastro**. A conta só libera vendas pagas quando Pix, cartões e repasses estão habilitados.

Esse botão também registra o domínio de `APP_URL` na conta conectada para as carteiras digitais. Use HTTPS e a URL final da plataforma. Se mudar o domínio, atualize `APP_URL` e clique novamente em Verificar cadastro em cada organização. Confirme o domínio no painel Stripe; dispositivos, cartões cadastrados e navegador determinam se Apple Pay/Google Pay aparecem. Não é necessário comprar um domínio próprio para começar com o endereço HTTPS da Vercel.

Em Administração da plataforma, defina a comissão da organização. Exemplo: ingresso de R$ 50 com 5% incluídos gera R$ 2,50 para a plataforma; o organizador fica com R$ 47,50 antes das tarifas Stripe. Se acrescida, o comprador vê R$ 52,50 antes da reserva. Percentual vazio bloqueia a venda; zero é uma escolha explícita. Consulte tarifas atuais de Pix, cartão e Connect no contrato/painel; a troca de provedor não garante redução de custo.

## 5. Teste completo antes de vender

Crie um evento e lote de teste. Com a conta conectada de teste habilitada, reserve um ingresso, gere o Pix e use o cenário de simulação descrito pela Stripe. Confira o evento recebido no webhook, pedido confirmado, ingresso com QR Code e comissão na transação da conta conectada. Use os cartões de teste oficiais da Stripe para testar aprovação, recusa e autenticação. Teste carteiras em dispositivos compatíveis e domínio registrado; um botão ausente em ambiente incompatível é esperado. Cartões de débito dependem da aceitação do emissor e da rede no fluxo online; não se promete aceitação universal.

Depois, peça reembolso pela conta do comprador e aprove pelo organizador. Confira o estorno, a devolução da comissão e a invalidação do ingresso. Não use dinheiro real para simular estes cenários. Os testes automatizados do projeto usam respostas controladas do provedor; eles não substituem essa homologação com sua conta.

## 6. Ativação real

Somente depois da homologação, substitua pelas chaves `sk_live_...` e `pk_live_...`, configure `STRIPE_ENV=production` e crie o destino Connect **de produção**, com seu próprio `whsec_...`. Faça novo deploy. Contas conectadas e domínios precisam estar habilitados no ambiente real. Finalize o cadastro real de recebimento, publique termos/contato e configure o agendamento de `/api/jobs` conforme OPERACAO.md. Não alterne teste/produção enquanto houver pedidos de teste aguardando processamento; conclua ou cancele-os antes da transição.

## Operação e limites

- A reserva Stripe dura 30 minutos. O Pix é criado com validade de 30 minutos a partir de sua confirmação; o código pode continuar válido no banco depois que a reserva acabar. Um pagamento tardio só emite ingresso se ainda houver capacidade. Caso contrário, inicia estorno, sem vender acima do estoque.
- A sessão segura do provedor expira 30 minutos após o fim da reserva, para atender ao prazo mínimo da Stripe mesmo quando o comprador abre o formulário mais tarde. Isso não prolonga o bloqueio de estoque. Ao encerrar a reserva, a Invicta fecha o formulário; a conferência transacional do servidor continua valendo em qualquer confirmação posterior.
- Pix e cartão têm sessões distintas, reutilizadas com idempotência. Se alguém pagar as duas, o segundo pagamento é encaminhado a estorno. Não emita ingresso pela resposta do navegador.
- Reembolsos deste sistema são integrais. Estorno externo parcial invalida o pedido inteiro; não faça estornos parciais pelo painel sem tratar os ingressos correspondentes.
- O reembolso devolve também a comissão. Taxas não devolvidas pelo provedor e saldo insuficiente do recebedor precisam ser considerados na operação. A fila acompanha e tenta novamente estornos pendentes; acompanhe tarefas com falha no painel.
- Pedidos mantêm o provedor original. Preserve as credenciais/webhook do Mercado Pago para conciliação e devolução de pedidos antigos. A ativação Stripe não converte uma compra anterior; pedidos novos seguem o provedor ativo.
- O servidor não recebe PAN/CVC. Dados de pagamento são coletados pelos elementos seguros Stripe. Client secrets são entregues apenas ao titular autenticado do pedido e não devem entrar em logs, URLs ou armazenamento offline.

## Referências oficiais

- [Pix: disponibilidade, limites e Connect](https://docs.stripe.com/payments/pix)
- [Cobranças diretas e comissão](https://docs.stripe.com/connect/direct-charges)
- [Cadastro hospedado de organizadores](https://docs.stripe.com/connect/hosted-onboarding)
- [Checkout Elements](https://docs.stripe.com/payments/quickstart)
- [Domínios para carteiras digitais](https://docs.stripe.com/payments/payment-methods/pmd-registration)
- [Testar pagamentos](https://docs.stripe.com/testing)
