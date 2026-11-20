/* ═══════════════════════════════════════════════════════
   Brechó Live Tracker - Frontend Logic
   ═══════════════════════════════════════════════════════ */

// ─── State ──────────────────────────────────────────
let ws = null;
let isSSNConnected = false; // fonte do chat conectada (SSN ou Meta)
let chatSource = 'ssn';      // fonte escolhida na tela: 'ssn' | 'meta'
let connectedSource = null;  // fonte conectada no servidor
let isSheetsConnected = false;
let isTracking = false;
let activeCode = null;
let currentMatches = [];
let history = [];
let chatMessageCount = 0;

// ─── DOM Elements ───────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  // Config
  btnToggleConfig: $('#btnToggleConfig'),
  configPanel: $('#configPanel'),
  ssnSessionId: $('#ssnSessionId'),
  btnConnectSSN: $('#btnConnectSSN'),
  sourceRadios: $$('input[name="chatSource"]'),
  ssnFields: $('#ssnFields'),
  metaFields: $('#metaFields'),
  metaCredentialsPath: $('#metaCredentialsPath'),
  btnConnectMeta: $('#btnConnectMeta'),
  metaLiveInfo: $('#metaLiveInfo'),
  chatSourceLabel: $('#chatSourceLabel'),
  sheetsUrl: $('#sheetsUrl'),
  credentialsPath: $('#credentialsPath'),
  btnConnectSheets: $('#btnConnectSheets'),
  ssnStatusBadge: $('#ssnStatusBadge'),
  sheetsStatusBadge: $('#sheetsStatusBadge'),

  // Piece
  inputCode: $('#inputCode'),
  inputDescription: $('#inputDescription'),
  inputValue: $('#inputValue'),
  btnTrack: $('#btnTrack'),
  btnStop: $('#btnStop'),
  activeCodeDisplay: $('#activeCodeDisplay'),
  activeCodeValue: $('#activeCodeValue'),

  // Results
  resultsPanel: $('#resultsPanel'),
  resultsEmpty: $('#resultsEmpty'),
  resultsList: $('#resultsList'),
  resultBuyer: $('#resultBuyer'),
  buyerNick: $('#buyerNick'),
  buyerTime: $('#buyerTime'),
  queueList: $('#queueList'),

  // Chat
  chatFeed: $('#chatFeed'),
  chatCount: $('#chatCount'),
  btnExportChat: $('#btnExportChat'),

  // History
  historyTableBody: $('#historyTableBody'),
  historyCount: $('#historyCount'),
  btnExportCSV: $('#btnExportCSV'),
  btnCopyClipboard: $('#btnCopyClipboard'),

  // Toast
  toastContainer: $('#toastContainer'),
};

// ─── WebSocket Connection ───────────────────────────
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    console.log('✅ Conectado ao backend');
  };

  ws.onclose = () => {
    console.log('❌ Desconectado do backend, reconectando...');
    setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = (err) => {
    console.error('Erro WebSocket:', err);
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleMessage(data);
  };
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ─── Message Handler ────────────────────────────────
function handleMessage(data) {
  switch (data.type) {
    case 'init_state':
      handleInitState(data);
      break;

    case 'ssn_status':
      handleSSNStatus(data);
      break;

    case 'meta_live':
      handleMetaLive(data);
      break;

    case 'sheets_status':
      handleSheetsStatus(data);
      break;

    case 'chat_message':
      handleChatMessage(data);
      break;

    case 'code_match':
      handleCodeMatch(data);
      break;

    case 'tracking_started':
      handleTrackingStarted(data);
      break;

    case 'tracking_stopped':
      handleTrackingStopped();
      break;

    case 'piece_saved':
      handlePieceSaved(data);
      break;

    case 'matches_updated':
      handleMatchesUpdated(data);
      break;

    case 'csv_data':
      downloadCSV(data.csv);
      break;

    case 'chat_data':
      downloadChat(data.text, data.count);
      break;
  }
}

// ─── Init State ─────────────────────────────────────
function handleInitState(data) {
  isSSNConnected = data.ssnConnected;
  isSheetsConnected = data.sheetsConnected;
  activeCode = data.activeCode;
  currentMatches = data.currentMatches || [];
  history = data.history || [];

  // Total de mensagens já registradas no servidor (sobrevive ao recarregar a página)
  chatMessageCount = data.chatCount || 0;
  els.chatCount.textContent = chatMessageCount;

  // Restore session ID
  if (data.ssnSessionId) {
    els.ssnSessionId.value = data.ssnSessionId;
  }
  if (data.metaCredentialsPath) {
    els.metaCredentialsPath.value = data.metaCredentialsPath;
  }

  // Load saved config
  loadSavedConfig();

  // Fonte já conectada no servidor tem prioridade sobre a salva no navegador
  connectedSource = data.chatSource || null;
  if (connectedSource) setChatSource(connectedSource);
  updateConnectButtons();
  updateMetaLiveInfo(!!data.metaLive);

  updateSSNStatusUI();
  updateSheetsStatusUI();

  if (activeCode && data.activePiece) {
    isTracking = true;
    updateActiveCodeUI(activeCode);
    els.inputCode.value = data.activePiece.code;
    els.inputDescription.value = data.activePiece.description;
    els.inputValue.value = data.activePiece.value;
    renderMatches();
  }

  renderHistory();
  updateTrackingUI();
}

// ─── Fonte do chat (SSN ou Instagram/Meta) ──────────
const SOURCE_NAMES = { ssn: 'Social Stream Ninja', meta: 'Instagram (Meta)' };

function setChatSource(source) {
  chatSource = source === 'meta' ? 'meta' : 'ssn';
  els.sourceRadios.forEach(r => { r.checked = r.value === chatSource; });
  els.ssnFields.classList.toggle('hidden', chatSource !== 'ssn');
  els.metaFields.classList.toggle('hidden', chatSource !== 'meta');
  els.chatSourceLabel.textContent = chatSource === 'meta' ? 'Meta' : 'SSN';
}

function updateConnectButtons() {
  const ssnOn = isSSNConnected && connectedSource === 'ssn';
  const metaOn = connectedSource === 'meta';
  els.btnConnectSSN.textContent = ssnOn ? 'Desconectar' : 'Conectar';
  els.btnConnectSSN.classList.toggle('btn-connect-active', ssnOn);
  els.btnConnectMeta.textContent = metaOn ? 'Desconectar' : 'Conectar';
  els.btnConnectMeta.classList.toggle('btn-connect-active', metaOn);
}

function handleSSNStatus(data) {
  const source = data.source || 'ssn';
  const nome = SOURCE_NAMES[source];
  const eraConectado = isSSNConnected && connectedSource === source;

  if (data.connected) {
    connectedSource = source;
    isSSNConnected = true;
    setChatSource(source);
    if (!eraConectado) showToast(`${nome} conectado!`, 'success');
  } else {
    // Instagram (Meta) com erro de leitura continua ligado e tenta de novo sozinho
    const continuaTentando = source === 'meta' && connectedSource === 'meta' && data.error && !data.fatal;
    if (connectedSource === source && !continuaTentando) connectedSource = null;
    if (connectedSource === null || connectedSource === source) isSSNConnected = false;
    if (data.error) showToast(`Erro ${nome}: ${data.error}`, 'error');
  }

  updateSSNStatusUI();
  updateConnectButtons();
}

function handleMetaLive(data) {
  updateMetaLiveInfo(data.live);
  if (data.live) {
    showToast('Live do Instagram detectada! Lendo os comentários.', 'success');
  } else {
    showToast('Nenhuma live do Instagram em andamento.', 'info');
  }
}

function updateMetaLiveInfo(live) {
  els.metaLiveInfo.textContent = live ? '🔴 Live em andamento.' : 'Nenhuma live em andamento.';
}

function updateSSNStatusUI() {
  const dot = els.ssnStatusBadge.querySelector('.status-dot');
  dot.classList.toggle('connected', isSSNConnected);
  dot.classList.toggle('disconnected', !isSSNConnected);
}

// ─── Sheets Status ──────────────────────────────────
function handleSheetsStatus(data) {
  isSheetsConnected = data.connected;
  updateSheetsStatusUI();

  if (data.connected) {
    showToast(`Planilha conectada: "${data.title}"`, 'success');
    els.btnConnectSheets.textContent = 'Conectado ✓';
    els.btnConnectSheets.classList.add('btn-connect-active');
  } else {
    els.btnConnectSheets.textContent = 'Conectar';
    els.btnConnectSheets.classList.remove('btn-connect-active');
    if (data.error) {
      showToast(`Erro Sheets: ${data.error}`, 'error');
    }
  }
}

function updateSheetsStatusUI() {
  const dot = els.sheetsStatusBadge.querySelector('.status-dot');
  dot.classList.toggle('connected', isSheetsConnected);
  dot.classList.toggle('disconnected', !isSheetsConnected);
}

// ─── Chat Messages ──────────────────────────────────
function handleChatMessage(data) {
  chatMessageCount++;
  els.chatCount.textContent = chatMessageCount;

  const feed = els.chatFeed;

  // Remove empty message
  const empty = feed.querySelector('.chat-empty');
  if (empty) empty.remove();

  // Check if message matches active code
  const isMatch = activeCode && data.message.trim() === activeCode;

  const msgEl = document.createElement('div');
  msgEl.className = `chat-msg${isMatch ? ' match' : ''}`;
  msgEl.innerHTML = `
    <span class="chat-nick">${escapeHtml(data.nick)}</span>
    <span class="chat-text">${escapeHtml(data.message)}</span>
  `;

  feed.appendChild(msgEl);

  // Auto-scroll to bottom
  const isScrolledNear = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 80;
  if (isScrolledNear) {
    feed.scrollTop = feed.scrollHeight;
  }

  // Limit chat messages to 500
  while (feed.children.length > 500) {
    feed.removeChild(feed.firstChild);
  }
}

// ─── Code Match ─────────────────────────────────────
function handleCodeMatch(data) {
  currentMatches.push({
    nick: data.nick,
    timestamp: data.timestamp,
    avatar: data.avatar,
  });

  renderMatches();
  playNotificationSound();

  const position = data.position;
  const label = position === 1 ? '🏆 Comprador' : `📋 Fila ${position - 1}`;
  showToast(`${label}: ${data.nick}`, 'match');

  // Flash the results panel
  els.resultsPanel.classList.add('match-flash');
  setTimeout(() => els.resultsPanel.classList.remove('match-flash'), 1500);
}

// ─── Tracking ───────────────────────────────────────
function handleTrackingStarted(data) {
  isTracking = true;
  activeCode = data.code;
  currentMatches = [];
  updateActiveCodeUI(data.code);
  updateTrackingUI();
  renderMatches();
  showToast(`Rastreando código: ${data.code}`, 'info');
}

function handleTrackingStopped() {
  isTracking = false;
  activeCode = null;
  currentMatches = [];
  updateActiveCodeUI(null);
  updateTrackingUI();
  renderMatches();
}

function handlePieceSaved(data) {
  history.push(data.piece);
  renderHistory();
}

function handleMatchesUpdated(data) {
  currentMatches = data.matches;
  renderMatches();
}

// ─── UI Updates ─────────────────────────────────────
function updateActiveCodeUI(code) {
  if (code) {
    els.activeCodeDisplay.classList.add('active');
    els.activeCodeValue.textContent = code;
    document.querySelector('.active-code-label').textContent = 'RASTREANDO CÓDIGO';
  } else {
    els.activeCodeDisplay.classList.remove('active');
    els.activeCodeValue.textContent = '---';
    document.querySelector('.active-code-label').textContent = 'AGUARDANDO CÓDIGO';
  }
}

function updateTrackingUI() {
  els.btnTrack.disabled = isTracking;
  els.btnStop.disabled = !isTracking;
}

function renderMatches() {
  if (currentMatches.length === 0) {
    els.resultsEmpty.style.display = isTracking ? 'flex' : 'flex';
    els.resultsList.style.display = 'none';
    els.resultBuyer.style.display = 'none';
    
    if (isTracking) {
      els.resultsEmpty.innerHTML = `
        <p>Aguardando alguém digitar <strong style="color: var(--accent-gold); font-family: var(--font-mono);">${activeCode}</strong></p>
        <p class="hint">O primeiro a digitar será o comprador</p>
      `;
    } else {
      els.resultsEmpty.innerHTML = `
        <p>Nenhum código sendo rastreado</p>
        <p class="hint">Digite um código e clique em "Rastrear" para começar</p>
      `;
    }
    return;
  }

  els.resultsEmpty.style.display = 'none';
  els.resultsList.style.display = 'block';

  // Buyer (first match)
  const buyer = currentMatches[0];
  els.resultBuyer.style.display = 'flex';
  els.buyerNick.textContent = buyer.nick;
  els.buyerTime.textContent = formatTime(buyer.timestamp);
  els.resultBuyer.querySelector('.btn-remove').setAttribute('data-index', '0');

  // Queue
  els.queueList.innerHTML = '';
  for (let i = 1; i < currentMatches.length; i++) {
    const match = currentMatches[i];
    const queueEl = document.createElement('div');
    queueEl.className = 'queue-item';
    queueEl.innerHTML = `
      <div class="result-badge queue">Fila ${i}</div>
      <div class="result-nick">${escapeHtml(match.nick)}</div>
      <div class="result-time">${formatTime(match.timestamp)}</div>
      <button class="btn-remove" data-index="${i}" title="Remover">✕</button>
    `;
    els.queueList.appendChild(queueEl);
  }
}

function renderHistory() {
  const tbody = els.historyTableBody;
  
  if (history.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Nenhuma peça registrada ainda</td></tr>';
    els.historyCount.textContent = '0 peças';
    return;
  }

  tbody.innerHTML = '';
  els.historyCount.textContent = `${history.length} peça${history.length !== 1 ? 's' : ''}`;

  for (const piece of history) {
    const tr = document.createElement('tr');

    const queueNicks = piece.queue ? piece.queue.map(q => q.nick).join(', ') : '';

    tr.innerHTML = `
      <td class="code-cell">${escapeHtml(piece.code)}</td>
      <td>${escapeHtml(piece.description)}</td>
      <td class="value-cell">R$ ${escapeHtml(String(piece.value))}</td>
      <td class="buyer-cell">${escapeHtml(piece.buyer || '-')}</td>
      <td class="queue-cell">${escapeHtml(queueNicks) || '-'}</td>
      <td class="${piece.sheetSynced ? 'sync-ok' : 'sync-fail'}">${piece.sheetSynced ? '✅' : '⚠️'}</td>
    `;

    tbody.appendChild(tr);
  }
}

// ─── Event Listeners ────────────────────────────────

// Toggle config panel
els.btnToggleConfig.addEventListener('click', () => {
  els.configPanel.classList.toggle('collapsed');
});

// Escolha da fonte do chat
els.sourceRadios.forEach(radio => {
  radio.addEventListener('change', () => {
    setChatSource(radio.value);
    saveConfig();
  });
});

// Connect Instagram (Meta) via banco
els.btnConnectMeta.addEventListener('click', () => {
  if (connectedSource === 'meta') {
    send({ action: 'disconnect_meta' });
  } else {
    const credentialsPath = els.metaCredentialsPath.value.trim() || 'credentials/mysql.json';
    saveConfig();
    send({ action: 'connect_meta', credentialsPath });
  }
});

// Connect SSN
els.btnConnectSSN.addEventListener('click', () => {
  if (isSSNConnected && connectedSource === 'ssn') {
    send({ action: 'disconnect_ssn' });
  } else {
    const sessionId = els.ssnSessionId.value.trim();
    if (!sessionId) {
      showToast('Insira o Session ID do Social Stream Ninja', 'error');
      els.ssnSessionId.focus();
      return;
    }
    saveConfig();
    send({ action: 'connect_ssn', sessionId });
  }
});

// Connect Sheets
els.btnConnectSheets.addEventListener('click', () => {
  const sheetUrl = els.sheetsUrl.value.trim();
  const credPath = els.credentialsPath.value.trim();

  if (!sheetUrl) {
    showToast('Insira o link da planilha Google Sheets', 'error');
    els.sheetsUrl.focus();
    return;
  }

  if (!credPath) {
    showToast('Insira o caminho do arquivo de credenciais', 'error');
    els.credentialsPath.focus();
    return;
  }

  saveConfig();
  send({ action: 'connect_sheets', sheetUrl, credentialsPath: credPath });
});

// Track code
els.btnTrack.addEventListener('click', startTracking);

// Stop tracking
els.btnStop.addEventListener('click', () => {
  send({ action: 'stop_tracking' });
});

// Enter key on code input starts tracking
els.inputCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !isTracking) {
    startTracking();
  }
});

// Enter on description moves to value
els.inputDescription.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    els.inputValue.focus();
  }
});

// Enter on value moves to code (last field)
els.inputValue.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    els.inputCode.focus();
  }
});

function startTracking() {
  const code = els.inputCode.value.trim();
  const description = els.inputDescription.value.trim();
  const value = els.inputValue.value.trim();

  if (!code) {
    showToast('Digite o código da peça', 'error');
    els.inputCode.focus();
    return;
  }

  send({
    action: 'track_code',
    code,
    description,
    value,
  });

  // Clear inputs for next piece (keep focus ready)
  setTimeout(() => {
    els.inputCode.value = '';
    els.inputDescription.value = '';
    els.inputValue.value = '';
    els.inputDescription.focus();
  }, 100);
}

// Remove match (delegated event)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-remove');
  if (btn) {
    const index = parseInt(btn.getAttribute('data-index'));
    send({ action: 'remove_match', index });
  }
});

// Export CSV
els.btnExportCSV.addEventListener('click', () => {
  send({ action: 'export_csv' });
});

// Export chat (arquivo com todo o chat da live)
els.btnExportChat.addEventListener('click', () => {
  send({ action: 'export_chat' });
});

// Copy to clipboard
els.btnCopyClipboard.addEventListener('click', () => {
  const data = generateClipboardData();
  navigator.clipboard.writeText(data).then(() => {
    showToast('Dados copiados para o clipboard! Cole na planilha.', 'success');
  }).catch(() => {
    showToast('Erro ao copiar. Tente exportar CSV.', 'error');
  });
});

// ─── Helpers ────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    match: '🎯',
  };

  toast.innerHTML = `<span>${icons[type] || ''}</span><span>${escapeHtml(message)}</span>`;
  els.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3000);
}

function downloadCSV(csvContent) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const now = new Date();
  a.download = `live_${now.toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('CSV exportado com sucesso!', 'success');
}

function downloadChat(text, count) {
  if (!count) {
    showToast('Nenhuma mensagem de chat registrada ainda', 'error');
    return;
  }

  // BOM para o Bloco de Notas/Excel reconhecerem acentos e emojis (UTF-8)
  const blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}h${p(now.getMinutes())}`;
  a.download = `chat_live_${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`Chat exportado: ${count} mensagens`, 'success');
}

function generateClipboardData() {
  // Same format as CSV but tab-separated for Google Sheets paste
  const allPieces = [...history];

  const maxQueue = Math.max(0, ...allPieces.map(p => p.queue ? p.queue.length : 0));

  const headers = ['Externo', 'Interno', 'Descricao', 'Valor', 'Comprador'];
  for (let i = 1; i <= maxQueue; i++) headers.push(`Fila ${i}`);

  const rows = [headers.join('\t')];

  for (const piece of allPieces) {
    const row = [
      piece.code,
      '',
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

// ─── Notification Sound ─────────────────────────────
let audioCtx = null;

function playNotificationSound() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    // Create a pleasant "ding" sound
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.setValueAtTime(1100, audioCtx.currentTime + 0.1);

    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);

    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.3);
  } catch (e) {
    // Audio not available
  }
}

// ─── Config Persistence ─────────────────────────────
function saveConfig() {
  const config = {
    ssnSessionId: els.ssnSessionId.value,
    chatSource,
    metaCredentialsPath: els.metaCredentialsPath.value,
    sheetsUrl: els.sheetsUrl.value,
    credentialsPath: els.credentialsPath.value,
  };
  localStorage.setItem('brecho-live-config', JSON.stringify(config));
}

function loadSavedConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem('brecho-live-config') || '{}');
    if (saved.ssnSessionId && !els.ssnSessionId.value) {
      els.ssnSessionId.value = saved.ssnSessionId;
    }
    if (saved.metaCredentialsPath) {
      els.metaCredentialsPath.value = saved.metaCredentialsPath;
    }
    setChatSource(saved.chatSource || 'ssn');
    if (saved.sheetsUrl && !els.sheetsUrl.value) {
      els.sheetsUrl.value = saved.sheetsUrl;
    }
    if (saved.credentialsPath) {
      els.credentialsPath.value = saved.credentialsPath;
    }
  } catch (e) {}
}

// ─── Initialize ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();

  // Open config on first visit if nothing is saved
  const hasConfig = localStorage.getItem('brecho-live-config');
  if (!hasConfig) {
    els.configPanel.classList.remove('collapsed');
  }
});
