# Banco e pagamentos

## Banco

| Opção | Quando escolher | Custo e observação |
| --- | --- | --- |
| **Neon PostgreSQL** | Escolha inicial: manter a API simples e pagar conforme o uso | Free para começar, com 1 GB e 100 CU-h por projeto. Launch é por uso; a página publica US$ 0,106/CU-h e US$ 0,35/GB-mês. O valor “típico” anunciado não é uma mensalidade fixa. [Preços](https://neon.com/pricing). |
| **Supabase PostgreSQL** | Se quiser contratar também storage e outros serviços integrados | Free: 500 MB, pausa por inatividade. Pro a partir de US$ 25/mês, com backups diários de sete dias. O projeto usa conexão SQL; não depende do Auth do Supabase. [Preços](https://supabase.com/pricing). |
| PostgreSQL próprio | Quando já houver quem cuide de atualização, backup e recuperação | Menos serviços contratados; exige operação contínua. O código aceita uma URL PostgreSQL padrão. |

Minha recomendação é começar com Neon para desenvolvimento e escolher um plano com recuperação adequada antes do primeiro evento pago. Use conexão com pooling na API serverless, TLS conforme as instruções do provedor e um banco separado para homologação. Os limites gratuitos não substituem uma política de disponibilidade e backup.

## Recebimento e comissão

A Stripe Connect é o único provedor real integrado. O organizador cadastra uma conta Standard, os pagamentos são cobranças diretas e a comissão da plataforma é enviada em application_fee_amount. Pix depende da habilitação da conta; carteiras dependem também do domínio e dispositivo. Consulte [a ativação](STRIPE.md) e [as tarifas oficiais](https://stripe.com/br/pricing), incluindo as condições de Connect.

A comissão incide sobre o valor dos ingressos e não sobre o lucro contábil do evento. É configurável entre 0 e 20% por organização, descontada do organizador ou acrescentada ao comprador. Percentual vazio bloqueia a venda. O servidor fixa preço, taxa e total no pedido; alterações posteriores valem para novas reservas. Reembolsos são integrais e devolvem também a comissão, sujeitos ao processamento do provedor.

Stone/Pagar.me é uma alternativa futura para negociação. Não está integrada. Antes da troca, confirme a aprovação de uma plataforma de ingressos, cadastro de recebedores, Pix com split, carteiras, custos de repasse, estorno e contestações no mesmo contrato. [Split](https://docs.pagar.me/reference/split-1), [ofertas](https://website.pagar.me/ofertas).

Uma futura troca deve implementar o contrato do adaptador de pagamentos, preservar o provedor de cada pedido e definir como concluir transações anteriores antes de retirar a integração vigente.
