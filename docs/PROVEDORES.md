# Banco e pagamentos

Consulta às páginas oficiais em 7 de novembro de 2026. Tarifas, limites, elegibilidade e condições de liquidação devem ser confirmados na conta antes de vender.

## Banco

| Opção | Quando escolher | Custo e observação |
| --- | --- | --- |
| **Neon PostgreSQL** | Escolha inicial: manter a API simples e pagar conforme o uso | Free para começar, com 1 GB e 100 CU-h por projeto. Launch é por uso; a página publica US$ 0,106/CU-h e US$ 0,35/GB-mês. O valor “típico” anunciado não é uma mensalidade fixa. [Preços](https://neon.com/pricing). |
| **Supabase PostgreSQL** | Se quiser contratar também storage e outros serviços integrados | Free: 500 MB, pausa por inatividade. Pro a partir de US$ 25/mês, com backups diários de sete dias. O projeto usa conexão SQL; não depende do Auth do Supabase. [Preços](https://supabase.com/pricing). |
| PostgreSQL próprio | Quando já houver quem cuide de atualização, backup e recuperação | Menos serviços contratados; exige operação contínua. O código aceita uma URL PostgreSQL padrão. |

Minha recomendação é começar com Neon para desenvolvimento e escolher um plano com recuperação adequada antes do primeiro evento pago. Use conexão com pooling na API serverless, TLS conforme as instruções do provedor e um banco separado para homologação. Os limites gratuitos não substituem uma política de disponibilidade e backup.

## Recebimento e comissão

| Provedor | Adequação | Estado neste código |
| --- | --- | --- |
| **Mercado Pago Checkout Pro + split 1:1** | Checkout hospedado e conta própria para cada organizador. A plataforma recebe sua comissão e o organizador recebe o restante, descontadas também as tarifas do provedor. Exige OAuth e aprovação cadastral. [Integração](https://www.mercadopago.com.br/developers/pt/docs/split-payments/split-1-1/integration-configuration/integrate-marketplace), [pré-requisitos](https://www.mercadopago.com.br/developers/pt/docs/split-payments/split-1-1/prerequisites). | Adaptador implementado; requer suas credenciais e homologação. A tarifa depende do meio, prazo e condições da conta. Consulte o painel do vendedor. |
| **Asaas** | Alternativa para comparar Pix e split. Uma tarifa fixa pode compensar em ingressos maiores; calcule por pedido, incluindo taxas adicionais. [Split](https://docs.asaas.com/docs/split-de-pagamentos), [preços](https://www.asaas.com/precos-e-taxas). | Sugestão para uma futura troca de adaptador. Não está integrado. A tabela consultada mostra Pix R$ 2,15 e valor promocional R$ 1,08; crédito à vista R$ 0,49 + 2,99%, com promoção de três meses. Confirme elegibilidade, liquidação e custos de split. |
| **Pagar.me** | Comparar quando houver volume para negociar contrato e regras de recebedores. [Split](https://docs.pagar.me/docs/pedidos-com-split). | Sugestão comercial; não integrado. Peça proposta completa. |

A comissão configurada aqui incide sobre o **valor dos ingressos**, pois o sistema não calcula as despesas e o lucro contábil do evento. Ela é independente da tarifa de processamento. No Mercado Pago, o checkout de preferências recebe um valor em reais em `marketplace_fee`, calculado pela API a partir do percentual configurado. Não há custódia manual dos pagamentos pela Invicta.

Exemplo apenas ilustrativo: ingresso de R$ 50 e comissão escolhida de 5% geram R$ 2,50 para a plataforma. No modo **incluída**, o comprador paga R$ 50 e o organizador recebe R$ 47,50 menos a tarifa do provedor. No modo **acrescida**, o comprador paga R$ 52,50 e o organizador recebe R$ 50 menos a tarifa do provedor, calculada segundo o contrato sobre a cobrança. Esses valores não estimam impostos nem custos de estorno ou contestação.

Defina uma regra comercial escrita para taxas, cancelamentos, suporte e responsabilidades antes de ativar vendas. A comissão começa pendente. Um administrador da plataforma pode configurar entre 0 e 20% por organização em `plataforma.html`; as alterações valem para novas reservas. Estornos implementados são integrais. A devolução da tarifa do próprio provedor depende de suas regras.
