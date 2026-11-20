const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const mysql = require('mysql2/promise');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── State ──────────────────────────────────────────────
let ssnSocket = null;
let ssnSessionId = null;
let chatSource = null; // 'ssn' | 'meta' (fonte conectada no momento)
let activeCode = null;
let activePiece = null; // { code, description, value }
let currentMatches = []; // [{ nick, timestamp }]
let history = []; // all completed pieces
let sheetsAuth = null;
let sheetsClient = null;
let spreadsheetId = null;
let sheetName = null;
let credentialsPath = null;

// Rolling buffer of recent chat messages (últimos 5 min, máx 300)
const MESSAGE_BUFFER_MAX = 300;
const MESSAGE_BUFFER_TTL_MS = 5 * 60 * 1000; // 5 minutos
let messageBuffer = []; // [{ nick, message, timestamp, avatar }]

function addToMessageBuffer(entry) {
  const now = Date.now();
  messageBuffer.push(entry);
  // Remove mensagens mais antigas que 5 minutos
  messageBuffer = messageBuffer.filter(m => now - m.timestamp < MESSAGE_BUFFER_TTL_MS);
  // Limita ao máximo
  if (messageBuffer.length > MESSAGE_BUFFER_MAX) {
    messageBuffer = messageBuffer.slice(-MESSAGE_BUFFER_MAX);
  }
}

// Registro completo do chat (todas as mensagens desde que o app foi aberto),
// usado para gerar o arquivo de chat da live
let chatLog = []; // [{ nick, message, timestamp }]

// Varre o buffer em busca de matches retroativos para o código dado
function findRetroactiveMatches(code) {
  const matches = [];
  const seenNicks = new Set();
  // Percorre em ordem cronológica (mais antigo primeiro)
  for (const entry of messageBuffer) {
    if (entry.message === code && !seenNicks.has(entry.nick.toLowerCase())) {
      seenNicks.add(entry.nick.toLowerCase());
      matches.push(entry);
    }
  }
  return matches;
}

// ─── Google Sheets ──────────────────────────────────────

async function initGoogleSheets(credPath, sheetUrl) {
  try {
    // Extract spreadsheet ID from URL
    // URL format: https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit...
    const match = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) {
      throw new Error('URL da planilha inválida. Use o link completo da planilha Google.');
    }
    spreadsheetId = match[1];

    // Read credentials
    const credsFile = path.resolve(credPath);
    if (!fs.existsSync(credsFile)) {
      throw new Error(`Arquivo de credenciais não encontrado: ${credsFile}`);
    }
    const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
    credentialsPath = credsFile;

    // Authenticate
    sheetsAuth = new google.auth.JWT(
      creds.client_email,
      null,
      creds.private_key,
      ['https://www.googleapis.com/auth/spreadsheets']
    );

    await sheetsAuth.authorize();
    sheetsClient = google.sheets({ version: 'v4', auth: sheetsAuth });

    // Try to read the spreadsheet to validate access
    const spreadsheet = await sheetsClient.spreadsheets.get({
      spreadsheetId: spreadsheetId,
    });

    // Get first sheet name
    sheetName = spreadsheet.data.sheets[0].properties.title;

    console.log(`✅ Google Sheets conectado: "${spreadsheet.data.properties.title}" (aba: ${sheetName})`);

    // Check if header row exists, if not create it
    const headerCheck = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:H1`,
    });

    if (!headerCheck.data.values || headerCheck.data.values.length === 0) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1:H1`,
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [['Externo', 'Interno', 'Descricao', 'Valor', 'Comprador', 'Fila 1', 'Fila 2', 'Fila 3']],
        },
      });
      console.log('📝 Header criado na planilha');
    }

    return { success: true, title: spreadsheet.data.properties.title, sheet: sheetName };
  } catch (err) {
    console.error('❌ Erro Google Sheets:', err.message);
    sheetsClient = null;
    spreadsheetId = null;
    throw err;
  }
}

async function appendToSheet(pieceData) {
  if (!sheetsClient || !spreadsheetId) {
    console.warn('⚠️ Google Sheets não configurado, dados não enviados');
    return false;
  }

  try {
    // Build row: [Externo, Interno, Descrição, Valor, Comprador, Fila1, Fila2, ...]
    const row = [
      pieceData.code,
      '', // Interno - left empty
      pieceData.description,
      pieceData.value,
      pieceData.buyer || '',
      ...pieceData.queue.map(q => q.nick),
    ];

    await sheetsClient.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A:Z`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [row],
      },
    });

    console.log(`📊 Planilha atualizada: ${pieceData.code} - ${pieceData.description}`);
    return true;
  } catch (err) {
    console.error('❌ Erro ao atualizar planilha:', err.message);
    return false;
  }
}

async function updateSheetRow(rowIndex, pieceData) {
  if (!sheetsClient || !spreadsheetId) return false;

  try {
    const row = [
      pieceData.code,
      '',
      pieceData.description,
      pieceData.value,
      pieceData.buyer || '',
      ...pieceData.queue.map(q => q.nick),
    ];

    // rowIndex is 0-based in history, +2 for sheet (1 for header, 1 for 0-index)
    const sheetRow = rowIndex + 2;
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${sheetRow}:${columnLetter(row.length - 1)}${sheetRow}`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [row],
      },
    });

    return true;
  } catch (err) {
    console.error('❌ Erro ao atualizar linha:', err.message);
    return false;
  }
}

function columnLetter(index) {
  let letter = '';
  while (index >= 0) {
    letter = String.fromCharCode(65 + (index % 26)) + letter;
    index = Math.floor(index / 26) - 1;
  }
  return letter;
}

// ─── Processamento comum das mensagens do chat ──────────
// Usado pelas duas fontes (Social Stream Ninja e Instagram/Meta via banco).
// opts.live = false: mensagem antiga (carga inicial da live). Entra no registro do
// chat e na tela, mas não no buffer retroativo nem no rastreio do código atual.
function processChatMessage({ nick, message, timestamp, avatar = null, platform = 'unknown' }, opts = {}) {
  const live = opts.live !== false;
  const chatName = nick;
  const chatMessage = (message || '').trim();

  if (live) {
    // Armazena no buffer para possível match retroativo
    addToMessageBuffer({ nick: chatName, message: chatMessage, timestamp, avatar });
  }

  // Armazena no registro completo do chat (para exportação)
  chatLog.push({ nick: chatName, message: chatMessage, timestamp });

  if (live) console.log(`💬 [${chatName}]: "${chatMessage}"`);

  // Forward to frontend chat monitor
  broadcastToClients({
    type: 'chat_message',
    nick: chatName,
    message: chatMessage,
    platform,
    timestamp,
    avatar,
  });

  // Check if message matches active code EXACTLY
  if (live && activeCode && chatMessage === activeCode) {
    // Check if this nick already registered for this code
    const alreadyRegistered = currentMatches.some(m => m.nick.toLowerCase() === chatName.toLowerCase());

    if (!alreadyRegistered) {
      const entry = { nick: chatName, timestamp, avatar };
      currentMatches.push(entry);

      const position = currentMatches.length; // 1 = buyer, 2+ = queue

      console.log(`🎯 Match! ${chatName} → posição ${position} para código ${activeCode}`);

      broadcastToClients({
        type: 'code_match',
        nick: chatName,
        position,
        timestamp,
        avatar,
        code: activeCode,
      });

      // Update Google Sheets in real-time
      updateCurrentPieceInSheet();
    }
  }
}

// ─── Social Stream Ninja WebSocket ──────────────────────

let ssnPingInterval = null;

function connectToSSN(sessionId) {
  disconnectFromMeta(); // só uma fonte por vez
  chatSource = 'ssn';
  if (ssnSocket) {
    ssnSocket.close();
    ssnSocket = null;
  }
  if (ssnPingInterval) {
    clearInterval(ssnPingInterval);
    ssnPingInterval = null;
  }

  ssnSessionId = sessionId;
  const url = `wss://io.socialstream.ninja/join/${sessionId}/4`;
  console.log(`🔌 Conectando ao SSN: ${url}`);

  ssnSocket = new WebSocket(url);

  ssnSocket.on('open', () => {
    console.log('✅ Conectado ao Social Stream Ninja (Canal 4)');
    broadcastToClients({ type: 'ssn_status', connected: true, source: 'ssn' });

    // Keepalive ping every 25 seconds to prevent idle disconnect
    ssnPingInterval = setInterval(() => {
      if (ssnSocket && ssnSocket.readyState === WebSocket.OPEN) {
        ssnSocket.ping();
      }
    }, 25000);
  });

  ssnSocket.on('message', (rawData) => {
    try {
      const raw = rawData.toString();
      const data = JSON.parse(raw);

      // Only process actual chat messages
      if (!data.chatname || data.chatmessage === undefined || data.chatmessage === null) {
        // Log non-chat messages for debug
        if (data.chatname === undefined) console.log('📨 SSN (não-chat):', raw.substring(0, 100));
        return;
      }

      processChatMessage({
        nick: data.chatname,
        message: data.chatmessage || '',
        timestamp: Date.now(),
        avatar: data.chatimg || null,
        platform: data.type || 'unknown',
      });
    } catch (err) {
      // Ignore non-JSON messages
    }
  });

  ssnSocket.on('close', (code, reason) => {
    clearInterval(ssnPingInterval);
    ssnPingInterval = null;
    console.log(`❌ Desconectado do SSN (code: ${code}, reason: ${reason.toString() || 'sem motivo'})`);
    broadcastToClients({ type: 'ssn_status', connected: false, source: 'ssn' });
    // Reconnect after 3 seconds
    if (ssnSessionId) {
      setTimeout(() => {
        if (ssnSessionId) connectToSSN(ssnSessionId);
      }, 3000);
    }
  });

  ssnSocket.on('error', (err) => {
    console.error('❌ Erro SSN:', err.message);
    broadcastToClients({ type: 'ssn_status', connected: false, source: 'ssn', error: err.message });
  });
}

function disconnectFromSSN() {
  const estavaConectado = !!ssnSocket || !!ssnSessionId;
  ssnSessionId = null;
  if (ssnSocket) {
    ssnSocket.close();
    ssnSocket = null;
  }
  if (chatSource === 'ssn') chatSource = null;
  if (estavaConectado) broadcastToClients({ type: 'ssn_status', connected: false, source: 'ssn' });
}

// ─── Instagram (Meta) via banco do ABrechozeiraApp ─────
// O ABrechozeiraApp recebe os comentários da live pelos webhooks/API da Meta e grava
// na tabela ComentarioLive. Aqui lemos essa tabela a cada 1 s, só da live em andamento
// (LiveSession com Status = 'live' e sem EndedAt).

const META_INTERVALO_MS = 1000;
const META_LOTE = 500;

let metaPool = null;
let metaTimer = null;
let metaCredentialsPath = null;
let metaConnected = false;   // última consulta ao banco deu certo
let metaLiveVideoId = null;  // live em andamento detectada no banco
// Progresso por live: sobrevive a desconectar/reconectar, para não repetir comentários.
const metaUltimoIdPorLive = new Map();

function lerCredenciaisMySQL(credPath) {
  const arquivo = path.resolve(credPath);
  if (!fs.existsSync(arquivo)) {
    throw new Error(`Arquivo de credenciais do banco não encontrado: ${arquivo}`);
  }
  const c = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  for (const campo of ['host', 'user', 'password', 'database']) {
    if (!c[campo]) throw new Error(`Campo "${campo}" faltando em ${credPath}`);
  }
  return c;
}

function setMetaConnected(conectado, extra = {}) {
  if (metaConnected === conectado && !extra.error && !extra.force) return;
  metaConnected = conectado;
  broadcastToClients({ type: 'ssn_status', connected: conectado, source: 'meta', ...extra });
}

async function connectToMeta(credPath) {
  disconnectFromSSN(); // só uma fonte por vez
  await disconnectFromMeta();

  const creds = lerCredenciaisMySQL(credPath);
  metaCredentialsPath = credPath;
  chatSource = 'meta';

  metaPool = mysql.createPool({
    host: creds.host,
    port: Number(creds.port) || 3306,
    user: creds.user,
    password: creds.password,
    database: creds.database,
    connectionLimit: 2,
    connectTimeout: 10000,
    timezone: 'local',
    // IDs de live da Meta passam de 2^53: como número, o JavaScript arredonda o último dígito
    // (ex.: ...357 virava ...356) e o app procurava os comentários na live errada.
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  // Testa a conexão antes de começar
  await metaPool.query('SELECT 1');
  console.log(`✅ Conectado ao banco (${creds.host}/${creds.database}) - fonte Instagram (Meta)`);
  setMetaConnected(true, { force: true });

  agendarPollMeta(0);
  iniciarVerificacaoCaptura();
}

// ─── Status da captura na API (abrechozeiraApp) ─────────
// A API roda no IIS da KingHost, que desliga o site depois de um tempo sem requisições.
// Desligada, ela para de buscar os comentários na Meta. Enquanto a fonte Meta estiver
// conectada, o Tracker chama esta rota a cada minuto: isso mantém a API acordada (ou a
// acorda) e avisa na tela se a captura parou.
const META_STATUS_URL = process.env.ABRECHOZEIRA_STATUS_URL || 'https://api.abrechozeira.com.br/api/status/captura';
const META_STATUS_INTERVALO_MS = 60 * 1000;
const META_CAPTURA_ATRASO_MAX_S = 45; // a captura roda a cada 1 s (live) ou 15 s (sem live)
let metaStatusTimer = null;
let metaCaptura = { ok: null, detalhe: 'Verificando a API...' };

async function verificarCapturaApi() {
  let estado;
  const controle = new AbortController();
  const limite = setTimeout(() => controle.abort(), 30000); // acordar a API pode levar alguns segundos
  try {
    const resp = await fetch(META_STATUS_URL, { signal: controle.signal });
    if (resp.status === 404 || resp.status === 401) {
      estado = { ok: null, detalhe: 'API acordada (versão sem a rota de status).' };
    } else if (!resp.ok) {
      estado = { ok: false, detalhe: `API respondeu com erro ${resp.status}.` };
    } else {
      const s = await resp.json();
      const atraso = s.segundosDesdeUltimoCiclo;
      estado = (atraso !== null && atraso !== undefined && atraso <= META_CAPTURA_ATRASO_MAX_S)
        ? { ok: true, detalhe: 'Captura da API funcionando.' }
        : { ok: false, detalhe: 'A API está no ar, mas a captura de comentários não está rodando.' };
    }
  } catch (err) {
    estado = { ok: false, detalhe: 'A API não respondeu (tentando acordar).' };
  } finally {
    clearTimeout(limite);
  }

  if (!metaPool) return; // desconectou enquanto esperava
  if (estado.ok !== metaCaptura.ok) {
    console.log(estado.ok === false ? `⚠️ ${estado.detalhe}` : `🟢 ${estado.detalhe}`);
  }
  metaCaptura = estado;
  broadcastToClients({ type: 'meta_captura', ...metaCaptura });
}

function iniciarVerificacaoCaptura() {
  pararVerificacaoCaptura();
  metaCaptura = { ok: null, detalhe: 'Verificando a API...' };
  verificarCapturaApi();
  metaStatusTimer = setInterval(verificarCapturaApi, META_STATUS_INTERVALO_MS);
}

function pararVerificacaoCaptura() {
  if (metaStatusTimer) {
    clearInterval(metaStatusTimer);
    metaStatusTimer = null;
  }
}

function agendarPollMeta(atraso) {
  if (metaTimer) clearTimeout(metaTimer);
  metaTimer = setTimeout(pollMeta, atraso);
}

async function pollMeta() {
  metaTimer = null;
  if (!metaPool || chatSource !== 'meta') return;

  try {
    const [lives] = await metaPool.query(
      "SELECT CAST(LiveVideoId AS CHAR) AS LiveVideoId FROM LiveSession WHERE Status = 'live' AND EndedAt IS NULL ORDER BY Id DESC LIMIT 1"
    );
    const liveAtual = lives.length > 0 ? String(lives[0].LiveVideoId) : null;

    if (liveAtual !== metaLiveVideoId) {
      metaLiveVideoId = liveAtual;
      if (liveAtual) {
        console.log(`🔴 Live do Instagram detectada no banco: ${liveAtual}`);
      } else {
        console.log('⚪ Nenhuma live do Instagram em andamento no banco');
      }
      broadcastToClients({ type: 'meta_live', live: !!liveAtual, liveVideoId: liveAtual });
    }

    if (liveAtual) {
      // Primeira leitura desta live: tudo o que já existe é "antigo" (não entra no rastreio).
      const primeiraLeitura = !metaUltimoIdPorLive.has(liveAtual);
      let ultimoId = metaUltimoIdPorLive.get(liveAtual) || 0;
      let veioLoteCheio = true;

      while (veioLoteCheio && metaPool) {
        const [rows] = await metaPool.query(
          'SELECT Id, Username, CommentText, CreatedAt FROM ComentarioLive WHERE LiveSessionId = ? AND Id > ? ORDER BY Id LIMIT ?',
          [liveAtual, ultimoId, META_LOTE]
        );

        for (const r of rows) {
          const criadoEm = r.CreatedAt instanceof Date ? r.CreatedAt.getTime() : Date.now();
          processChatMessage(
            {
              nick: r.Username,
              message: r.CommentText,
              // Mensagem nova: hora de chegada (mesma base do buffer retroativo).
              // Mensagem antiga: hora gravada no banco (só para exibição/exportação).
              timestamp: primeiraLeitura ? criadoEm : Date.now(),
              platform: 'instagram',
            },
            { live: !primeiraLeitura }
          );
          ultimoId = r.Id;
        }

        metaUltimoIdPorLive.set(liveAtual, ultimoId);
        veioLoteCheio = rows.length === META_LOTE;
        if (primeiraLeitura && rows.length > 0) {
          console.log(`📥 ${rows.length} comentário(s) anteriores da live carregados`);
        }
      }
    }

    setMetaConnected(true);
  } catch (err) {
    console.error('❌ Erro ao ler comentários do banco:', err.message);
    if (metaConnected) setMetaConnected(false, { error: err.message });
  }

  if (metaPool && chatSource === 'meta') agendarPollMeta(META_INTERVALO_MS);
}

async function disconnectFromMeta() {
  pararVerificacaoCaptura();
  if (metaTimer) {
    clearTimeout(metaTimer);
    metaTimer = null;
  }
  const estavaConectado = !!metaPool;
  if (metaPool) {
    const pool = metaPool;
    metaPool = null;
    try { await pool.end(); } catch (e) { /* ignora */ }
  }
  metaLiveVideoId = null;
  if (chatSource === 'meta') chatSource = null;
  if (estavaConectado) {
    metaConnected = false;
    broadcastToClients({ type: 'ssn_status', connected: false, source: 'meta' });
  }
}

// ─── Piece tracking helpers ─────────────────────────────

let currentSheetRow = null; // Track if we already appended or need to update

async function updateCurrentPieceInSheet() {
  if (!activePiece) return;

  const pieceData = {
    code: activePiece.code,
    description: activePiece.description,
    value: activePiece.value,
    buyer: currentMatches.length > 0 ? currentMatches[0].nick : '',
    queue: currentMatches.slice(1),
  };

  if (currentSheetRow === null) {
    // First match for this piece - append new row
    const success = await appendToSheet(pieceData);
    if (success) {
      // We need to know which row we're in for future updates
      // Get the last row number
      try {
        const res = await sheetsClient.spreadsheets.values.get({
          spreadsheetId,
          range: `${sheetName}!A:A`,
        });
        currentSheetRow = res.data.values ? res.data.values.length : 2;
      } catch (e) {
        currentSheetRow = null;
      }
    }
  } else {
    // Update existing row
    if (sheetsClient && spreadsheetId) {
      try {
        const row = [
          pieceData.code,
          '',
          pieceData.description,
          pieceData.value,
          pieceData.buyer,
          ...pieceData.queue.map(q => q.nick),
        ];

        await sheetsClient.spreadsheets.values.update({
          spreadsheetId,
          range: `${sheetName}!A${currentSheetRow}:${columnLetter(row.length - 1)}${currentSheetRow}`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [row] },
        });
      } catch (err) {
        console.error('❌ Erro ao atualizar linha:', err.message);
      }
    }
  }
}

function savePieceToHistory() {
  if (!activePiece) return null;

  const piece = {
    code: activePiece.code,
    description: activePiece.description,
    value: activePiece.value,
    buyer: currentMatches.length > 0 ? currentMatches[0].nick : '',
    queue: currentMatches.slice(1).map(m => ({ nick: m.nick, timestamp: m.timestamp })),
    sheetSynced: currentSheetRow !== null,
  };

  history.push(piece);
  return piece;
}

// ─── Local WebSocket (Frontend ↔ Backend) ───────────────

const clients = new Set();

function broadcastToClients(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('🖥️ Frontend conectado');

  // Send current state
  ws.send(JSON.stringify({
    type: 'init_state',
    ssnConnected: chatSource === 'meta' ? metaConnected : !!(ssnSocket && ssnSocket.readyState === WebSocket.OPEN),
    chatSource,
    metaCredentialsPath,
    metaLive: !!metaLiveVideoId,
    metaCaptura: metaPool ? metaCaptura : null,
    sheetsConnected: !!sheetsClient,
    activeCode,
    activePiece,
    currentMatches,
    history,
    ssnSessionId,
    spreadsheetId,
    chatCount: chatLog.length,
  }));

  ws.on('message', async (rawMsg) => {
    try {
      const msg = JSON.parse(rawMsg.toString());

      switch (msg.action) {
        case 'connect_ssn': {
          connectToSSN(msg.sessionId);
          break;
        }

        case 'disconnect_ssn': {
          disconnectFromSSN();
          break;
        }

        case 'connect_meta': {
          try {
            await connectToMeta(msg.credentialsPath || 'credentials/mysql.json');
          } catch (err) {
            console.error('❌ Erro ao conectar no banco:', err.message);
            await disconnectFromMeta();
            ws.send(JSON.stringify({ type: 'ssn_status', connected: false, source: 'meta', error: err.message }));
          }
          break;
        }

        case 'disconnect_meta': {
          await disconnectFromMeta();
          break;
        }

        case 'connect_sheets': {
          try {
            const result = await initGoogleSheets(msg.credentialsPath, msg.sheetUrl);
            ws.send(JSON.stringify({ type: 'sheets_status', connected: true, ...result }));
          } catch (err) {
            ws.send(JSON.stringify({ type: 'sheets_status', connected: false, error: err.message }));
          }
          break;
        }

        case 'track_code': {
          // Save previous piece if any
          if (activePiece && currentMatches.length > 0) {
            savePieceToHistory();
            broadcastToClients({
              type: 'piece_saved',
              piece: history[history.length - 1],
              historyIndex: history.length - 1,
            });
          } else if (activePiece) {
            // No matches, still save to history
            savePieceToHistory();
            broadcastToClients({
              type: 'piece_saved',
              piece: history[history.length - 1],
              historyIndex: history.length - 1,
            });
          }

          // Start tracking new code
          activeCode = msg.code.trim();
          activePiece = {
            code: activeCode,
            description: msg.description || '',
            value: msg.value || '',
          };
          currentMatches = [];
          currentSheetRow = null;

          console.log(`🏷️ Rastreando código: "${activeCode}" - ${activePiece.description} R$${activePiece.value}`);

          // ── Varredura retroativa no buffer de mensagens ──
          const retroMatches = findRetroactiveMatches(activeCode);
          if (retroMatches.length > 0) {
            console.log(`⏪ ${retroMatches.length} match(es) retroativo(s) encontrado(s) no buffer para "${activeCode}"`);
            for (const entry of retroMatches) {
              currentMatches.push(entry);
              const position = currentMatches.length;
              console.log(`🎯 [Retroativo] ${entry.nick} → posição ${position}`);
              broadcastToClients({
                type: 'code_match',
                nick: entry.nick,
                position,
                timestamp: entry.timestamp,
                avatar: entry.avatar,
                code: activeCode,
                retroactive: true,
              });
            }
            updateCurrentPieceInSheet();
          }

          broadcastToClients({
            type: 'tracking_started',
            code: activeCode,
            piece: activePiece,
            retroCount: retroMatches.length,
          });
          break;
        }

        case 'stop_tracking': {
          if (activePiece) {
            savePieceToHistory();
            broadcastToClients({
              type: 'piece_saved',
              piece: history[history.length - 1],
              historyIndex: history.length - 1,
            });
          }
          activeCode = null;
          activePiece = null;
          currentMatches = [];
          currentSheetRow = null;
          broadcastToClients({ type: 'tracking_stopped' });
          break;
        }

        case 'remove_match': {
          const idx = msg.index;
          if (idx >= 0 && idx < currentMatches.length) {
            const removed = currentMatches.splice(idx, 1)[0];
            console.log(`🗑️ Removido: ${removed.nick} da posição ${idx + 1}`);
            broadcastToClients({
              type: 'matches_updated',
              matches: currentMatches,
              code: activeCode,
            });
            // Update sheet
            updateCurrentPieceInSheet();
          }
          break;
        }

        case 'export_csv': {
          const csvData = generateCSV();
          ws.send(JSON.stringify({ type: 'csv_data', csv: csvData }));
          break;
        }

        case 'export_chat': {
          ws.send(JSON.stringify({
            type: 'chat_data',
            text: generateChatLog(),
            count: chatLog.length,
          }));
          break;
        }

        default:
          console.warn('⚠️ Ação desconhecida:', msg.action);
      }
    } catch (err) {
      console.error('❌ Erro processando mensagem do frontend:', err.message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('🖥️ Frontend desconectado');
  });
});

// ─── CSV Export ──────────────────────────────────────────

function generateCSV() {
  const allPieces = [...history];
  if (activePiece) {
    allPieces.push({
      code: activePiece.code,
      description: activePiece.description,
      value: activePiece.value,
      buyer: currentMatches.length > 0 ? currentMatches[0].nick : '',
      queue: currentMatches.slice(1).map(m => ({ nick: m.nick })),
    });
  }

  // Find max queue length
  const maxQueue = Math.max(0, ...allPieces.map(p => p.queue ? p.queue.length : 0));

  // Header
  const headers = ['Externo', 'Interno', 'Descricao', 'Valor', 'Comprador'];
  for (let i = 1; i <= maxQueue; i++) headers.push(`Fila ${i}`);

  const rows = [headers.join('\t')];

  for (const piece of allPieces) {
    const row = [
      piece.code,
      '', // Interno
      piece.description,
      piece.value,
      piece.buyer || '',
    ];
    if (piece.queue) {
      for (const q of piece.queue) {
        row.push(q.nick);
      }
    }
    rows.push(row.join('\t'));
  }

  return rows.join('\n');
}

// ─── Chat Export ─────────────────────────────────────────

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDate(d) {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function formatTime(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// Gera o texto com todo o chat registrado (uma mensagem por linha)
function generateChatLog() {
  const now = new Date();
  const lines = [
    'Brechó Live Tracker - Chat da live',
    `Gerado em: ${formatDate(now)} ${formatTime(now)}`,
  ];

  if (chatLog.length > 0) {
    const first = new Date(chatLog[0].timestamp);
    const last = new Date(chatLog[chatLog.length - 1].timestamp);
    lines.push(`Período: ${formatDate(first)} ${formatTime(first)} até ${formatDate(last)} ${formatTime(last)}`);
  }
  lines.push(`Total de mensagens: ${chatLog.length}`);
  lines.push('------------------------------------------------------------');

  let currentDay = null;
  for (const entry of chatLog) {
    const d = new Date(entry.timestamp);
    const day = formatDate(d);
    // Marca a virada de dia (lives que passam da meia-noite)
    if (day !== currentDay) {
      lines.push(`--- ${day} ---`);
      currentDay = day;
    }
    const message = String(entry.message).replace(/\s*[\r\n]+\s*/g, ' ');
    lines.push(`[${formatTime(d)}] ${entry.nick}: ${message}`);
  }

  return lines.join('\r\n') + '\r\n';
}

// ─── Start Server ───────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('  🛍️  Brechó Live Tracker');
  console.log('═══════════════════════════════════════════════');
  console.log(`  🌐 Abra no navegador: http://localhost:${PORT}`);
  console.log('  📡 Aguardando conexão do frontend...');
  console.log('═══════════════════════════════════════════════');
  console.log('');
});
