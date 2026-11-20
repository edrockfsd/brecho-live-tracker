# 🛍️ Brechó Live Tracker

Rastreador de vendas ao vivo para brechó via Instagram Live, integrado com Google Sheets. O chat da live pode vir de duas fontes, escolhidas na tela:

- **Social Stream Ninja** (extensão do navegador, via WebSocket)
- **Instagram (Meta)** — comentários gravados pelo sistema da loja (ABrechozeiraApp) a partir dos webhooks/API oficiais da Meta, lidos direto do banco MySQL

## O que faz

Durante lives de venda de roupas no Instagram, o sistema:
- **Conecta ao chat** via Social Stream Ninja (WebSocket) **ou** pelo banco do sistema da loja (Instagram/Meta)
- **Monitora códigos** de peças digitados no chat
- **Identifica** o primeiro a digitar (comprador) e monta a fila de espera
- **Sincroniza em tempo real** com Google Sheets
- **Match exato** — apenas mensagens com o código exato são aceitas (ignora "005 quero", etc.)
- **Exporta o chat** — botão "Salvar chat" gera um `.txt` com todas as mensagens da live

## Requisitos

- Node.js 18+
- Fonte do chat: extensão [Social Stream Ninja](https://socialstream.ninja/) no navegador **ou** acesso ao banco MySQL do ABrechozeiraApp
- Conta Google Cloud com Google Sheets API ativada (para integração com planilha)

## Instalação

```bash
npm install
```

## Uso

```bash
node server.js
# Abrir http://localhost:3000
```

### Configuração inicial (primeira vez)

1. Crie um projeto no [Google Cloud Console](https://console.cloud.google.com/)
2. Ative a **Google Sheets API**
3. Crie uma **Service Account** e baixe o arquivo JSON de credenciais
4. Coloque o arquivo em `credentials/service-account.json`
5. Na extensão SSN, ative "Enable remote API control" e "Send chat messages to API server"
6. Para a fonte **Instagram (Meta)**, crie `credentials/mysql.json` (fica fora do git):
   ```json
   { "host": "mysql.exemplo.com.br", "port": 3306, "user": "usuario", "password": "senha", "database": "banco" }
   ```

### A cada live

1. Crie uma planilha nova no Google Sheets
2. Compartilhe com o email da Service Account (como Editor)
3. No app, em ⚙️ **Fonte do chat**, escolha:
   - **Social Stream Ninja**: cole o Session ID e clique em Conectar
   - **Instagram (Meta)**: clique em Conectar. O app acha sozinho a live em andamento (a que o sistema da loja detectou) e lê os comentários novos a cada 1 s. Os comentários de antes da conexão aparecem no chat e na exportação, mas não entram no rastreio dos códigos.
4. Cole o link da planilha
5. Comece a rastrear!

## Licença

MIT
