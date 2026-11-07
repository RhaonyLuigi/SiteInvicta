# Site Invicta

Protótipo acadêmico para a venda de ingressos dos eventos da Atlética Invicta de Biologia da UCB.

## Experimentar o fluxo

1. Na página inicial, escolha um lote, crie um pedido e simule a aprovação do pagamento.
2. Copie o código exibido abaixo do QR e abra **Testar na portaria** no mesmo navegador.
3. Valide o código duas vezes. A primeira tentativa registra a entrada e a segunda informa que o ingresso já foi utilizado.
4. Abra o painel para conferir os totais e experimentar o cadastro de um evento e de um lote.

Os dados de teste são locais ao navegador. O leitor de QR usa a câmera quando o navegador permite o acesso. A digitação do código também está disponível.

## Rodar localmente

Com o Python instalado, execute `python -m http.server 8000 --bind 127.0.0.1` na pasta do projeto e abra `http://127.0.0.1:8000`.

O módulo `demo-store.js` centraliza os dados simulados. Na integração com o back-end, o servidor passa a definir preços e estoque, confirmar pagamentos, emitir ingressos e registrar as entradas.

## Direção visual

O site aplica as orientações do [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/4f2dbb67e64969a9a30ab00742f2d55d66ddec2b), com as consultas `event ticketing welcoming vibrant`, `Inter Poster`, `focus not obscured` e `inline validation checkout`.

A direção Vibrant & Block-based foi adaptada aos verdes e tons claros da Invicta. As fontes Inter e Playfair Display são servidas pelo próprio site. As cores, estados e tempos de interação usam os mesmos tokens na página pública, no painel e no validador.

As licenças das fontes estão em `assets/fonts/`.

## Bibliotecas de QR Code

- [QR Code Generator 2.0.4](https://github.com/kazuhikoarase/qrcode-generator), licença MIT.
- [QR Scanner 1.4.2](https://github.com/nimiq/qr-scanner), licença MIT.
