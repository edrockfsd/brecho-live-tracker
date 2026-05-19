# 🛍️ Brechó Live Tracker

Rastreador de vendas ao vivo para brechó via Instagram Live, integrado com [Social Stream Ninja](https://socialstream.ninja/) e Google Sheets.

## O que faz

Durante lives de venda de roupas no Instagram, o sistema:
- **Conecta ao chat** via Social Stream Ninja (WebSocket)
- **Monitora códigos** de peças digitados no chat
- **Identifica** o primeiro a digitar (comprador) e monta a fila de espera
- **Sincroniza em tempo real** com Google Sheets
- **Match exato** — apenas mensagens com o código exato são aceitas (ignora "005 quero", etc.)

## Requisitos

- Node.js 18+
- Extensão [Social Stream Ninja](https://socialstream.ninja/) no navegador
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

### A cada live

1. Crie uma planilha nova no Google Sheets
2. Compartilhe com o email da Service Account (como Editor)
3. No app, cole o Session ID do SSN + link da planilha
4. Comece a rastrear!

## Licença

MIT
