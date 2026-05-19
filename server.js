const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── State ──────────────────────────────────────────────
let ssnSocket = null;
let ssnSessionId = null;
let activeCode = null;
let activePiece = null; // { code, description, value }
let currentMatches = []; // [{ nick, timestamp }]
let history = []; // all completed pieces
let sheetsAuth = null;
let sheetsClient = null;
let spreadsheetId = null;
let sheetName = null;
let credentialsPath = null;

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

// ─── Social Stream Ninja WebSocket ──────────────────────

function connectToSSN(sessionId) {
  if (ssnSocket) {
    ssnSocket.close();
    ssnSocket = null;
  }

  ssnSessionId = sessionId;
  const url = `wss://io.socialstream.ninja/join/${sessionId}/4`;
  console.log(`🔌 Conectando ao SSN: ${url}`);

  ssnSocket = new WebSocket(url);

  ssnSocket.on('open', () => {
    console.log('✅ Conectado ao Social Stream Ninja (Canal 4)');
    broadcastToClients({ type: 'ssn_status', connected: true });
  });

  ssnSocket.on('message', (rawData) => {
    try {
      const data = JSON.parse(rawData.toString());

      // Only process actual chat messages
      if (!data.chatname || data.chatmessage === undefined || data.chatmessage === null) return;

      const chatName = data.chatname;
      const chatMessage = (data.chatmessage || '').trim();
      const timestamp = Date.now();

      // Forward to frontend chat monitor
      broadcastToClients({
        type: 'chat_message',
        nick: chatName,
        message: chatMessage,
        platform: data.type || 'unknown',
        timestamp,
        avatar: data.chatimg || null,
      });

      // Check if message matches active code EXACTLY
      if (activeCode && chatMessage === activeCode) {
        // Check if this nick already registered for this code
        const alreadyRegistered =
          (currentMatches.length > 0 && currentMatches[0].nick.toLowerCase() === chatName.toLowerCase()) ||
          currentMatches.some(m => m.nick.toLowerCase() === chatName.toLowerCase());

        if (!alreadyRegistered) {
          const entry = { nick: chatName, timestamp, avatar: data.chatimg || null };
          currentMatches.push(entry);

          const position = currentMatches.length; // 1 = buyer, 2+ = queue

          console.log(`🎯 Match! ${chatName} → posição ${position} para código ${activeCode}`);

          broadcastToClients({
            type: 'code_match',
            nick: chatName,
            position,
            timestamp,
            avatar: data.chatimg || null,
            code: activeCode,
          });

          // Update Google Sheets in real-time
          updateCurrentPieceInSheet();
        }
      }
    } catch (err) {
      // Ignore non-JSON messages
    }
  });

  ssnSocket.on('close', () => {
    console.log('❌ Desconectado do SSN');
    broadcastToClients({ type: 'ssn_status', connected: false });
    // Reconnect after 3 seconds
    if (ssnSessionId) {
      setTimeout(() => {
        if (ssnSessionId) connectToSSN(ssnSessionId);
      }, 3000);
    }
  });

  ssnSocket.on('error', (err) => {
    console.error('❌ Erro SSN:', err.message);
    broadcastToClients({ type: 'ssn_status', connected: false, error: err.message });
  });
}

function disconnectFromSSN() {
  ssnSessionId = null;
  if (ssnSocket) {
    ssnSocket.close();
    ssnSocket = null;
  }
  broadcastToClients({ type: 'ssn_status', connected: false });
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
    ssnConnected: ssnSocket && ssnSocket.readyState === WebSocket.OPEN,
    sheetsConnected: !!sheetsClient,
    activeCode,
    activePiece,
    currentMatches,
    history,
    ssnSessionId,
    spreadsheetId,
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

          broadcastToClients({
            type: 'tracking_started',
            code: activeCode,
            piece: activePiece,
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
