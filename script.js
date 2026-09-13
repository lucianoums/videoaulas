// ============================================================
// TEMA CLARO / NOTURNO
// ============================================================
const TEMA_KEY = 'temaEscolhido';

function aplicarTema(tema) {
  const body = document.body;
  const btn = document.getElementById('btn-tema');

  if (tema === 'noturno') {
    body.classList.add('tema-noturno');
    if (btn) btn.textContent = '☀️';
  } else {
    body.classList.remove('tema-noturno');
    if (btn) btn.textContent = '🌙';
  }

  try {
    localStorage.setItem(TEMA_KEY, tema);
  } catch (e) {}
}

function alternarTema() {
  const atual = document.body.classList.contains('tema-noturno') ? 'noturno' : 'claro';
  aplicarTema(atual === 'noturno' ? 'claro' : 'noturno');
}

// ============================================================
// CONFIG
// ============================================================
const DB_NOME = 'videoaulasDB';
const DB_VERSAO = 1;
const STORE_DADOS = 'dados';
const STORE_META = 'meta';

let db = null;
let disciplinas = [];

let fileHandle = null;
let autoSalvarAtivo = false;

const aulasMinimizadas = new Set();
const disciplinasMinimizadas = new Set();

let playerAtual = null;
let temaAtual = null;
let velocidadeAtual = 1;
let intervaloSalvarProgresso = null;

let importPreviewData = null;
let temaAtualAnotacao = null;
let linksModalInfo = null;
let novoLinkTipoDetectado = null;

// ============================================================
// INDEXEDDB
// ============================================================
function abrirDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NOME, DB_VERSAO);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE_DADOS)) d.createObjectStore(STORE_DADOS);
      if (!d.objectStoreNames.contains(STORE_META)) d.createObjectStore(STORE_META);
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function dbGet(store, chave) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(chave);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(store, chave, valor) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(valor, chave);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbDelete(store, chave) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(chave);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================================
// MIGRAÇÃO
// ============================================================
function migrarDados(dados) {
  if (!Array.isArray(dados)) return [];

  return dados.map(disc => {
    if (!Array.isArray(disc.links)) disc.links = [];

    disc.aulas = (disc.aulas || []).map(aula => {
      if (!Array.isArray(aula.links)) aula.links = [];

      aula.temas = (aula.temas || []).map(tema => {
        if (!Array.isArray(tema.links)) {
          tema.links = [];
          if (tema.link && tema.link.trim() !== '') {
            tema.links.push({
              id: crypto.randomUUID(),
              url: tema.link,
              titulo: ''
            });
          }
          delete tema.link;
          delete tema.tipo;
        }
        return tema;
      });

      return aula;
    });

    return disc;
  });
}

// ============================================================
// SALVAR / CARREGAR
// ============================================================
async function carregarDados() {
  try {
    db = await abrirDB();
    let dados = await dbGet(STORE_DADOS, 'disciplinas');

    if (!dados) {
      const antigo = localStorage.getItem('disciplinas');
      if (antigo) {
        try {
          dados = JSON.parse(antigo);
          localStorage.removeItem('disciplinas');
        } catch (e) {}
      }
    }

    disciplinas = migrarDados(dados || []);
    await dbPut(STORE_DADOS, 'disciplinas', disciplinas);
    await restaurarHandleArquivo();
  } catch (e) {
    console.error('Erro ao carregar dados:', e);
    disciplinas = [];
  }
}

async function salvar() {
  try {
    await dbPut(STORE_DADOS, 'disciplinas', disciplinas);
    if (autoSalvarAtivo && fileHandle) {
      await gravarNoArquivo();
    }
  } catch (e) {
    console.error('Erro ao salvar:', e);
  }
}

// ============================================================
// FILE SYSTEM ACCESS API
// ============================================================
function suportaFileSystem() {
  return typeof window.showSaveFilePicker === 'function';
}

async function escolherArquivoLocal() {
  if (!suportaFileSystem()) {
    alert('❌ Navegador não suporta vincular arquivo local.\n\nUse "📤 Exportar JSON" para backup manual.');
    return;
  }

  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: 'videoaulas-backup.json',
      types: [{ description: 'Backup JSON', accept: { 'application/json': ['.json'] } }]
    });

    fileHandle = handle;
    let perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });

    if (perm !== 'granted') {
      alert('❌ Permissão não concedida.');
      fileHandle = null;
      autoSalvarAtivo = false;
      renderStorageInfo();
      return;
    }

    autoSalvarAtivo = true;
    const gravou = await gravarNoArquivo();

    if (!gravou) {
      alert('⚠️ Arquivo vinculado, mas falhou ao gravar.');
      autoSalvarAtivo = false;
      renderStorageInfo();
      return;
    }

    try { await dbPut(STORE_META, 'fileHandle', handle); } catch (e) {}

    renderStorageInfo();
    alert('✅ Arquivo vinculado!\n\n📁 ' + handle.name);
  } catch (e) {
    if (e.name !== 'AbortError') {
      alert('❌ Erro ao vincular: ' + e.message);
    }
  }
}

async function gravarNoArquivo() {
  if (!fileHandle) return false;
  try {
    let perm = await fileHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      perm = await fileHandle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        autoSalvarAtivo = false;
        renderStorageInfo();
        return false;
      }
    }
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(disciplinas, null, 2));
    await writable.close();
    return true;
  } catch (e) {
    console.error('Erro ao gravar:', e);
    return false;
  }
}

async function restaurarHandleArquivo() {
  try {
    const handle = await dbGet(STORE_META, 'fileHandle');
    if (!handle) return;
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    fileHandle = handle;
    autoSalvarAtivo = (perm === 'granted');
  } catch (e) {}
}

async function reconectarArquivo() {
  if (!fileHandle) { escolherArquivoLocal(); return; }
  try {
    const perm = await fileHandle.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      autoSalvarAtivo = true;
      await gravarNoArquivo();
      renderStorageInfo();
      alert('✅ Arquivo reconectado!');
    } else {
      alert('Permissão negada.');
    }
  } catch (e) {
    alert('Erro: ' + e.message);
  }
}

async function desvincularArquivo() {
  if (!confirm('Desvincular o arquivo local?')) return;
  fileHandle = null;
  autoSalvarAtivo = false;
  try { await dbDelete(STORE_META, 'fileHandle'); } catch (e) {}
  renderStorageInfo();
}

// ============================================================
// EXPORTAR / IMPORTAR JSON
// ============================================================
function exportarJSON() {
  const blob = new Blob([JSON.stringify(disciplinas, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `videoaulas-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importarJSON() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const texto = await file.text();
      const dados = JSON.parse(texto);
      if (!Array.isArray(dados)) throw new Error('Formato inválido.');
      if (!confirm(`Importar ${dados.length} disciplina(s)? Os dados atuais serão substituídos.`)) return;

      disciplinas = migrarDados(dados);
      await salvar();
      render();
      alert('✅ Backup importado!');
    } catch (err) {
      alert('Erro: ' + err.message);
    }
  };
  input.click();
}

// ============================================================
// RENDER
// ============================================================
function render() {
  renderSelects();
  renderListaDisciplinas();
  renderEstatisticas();
  renderStorageInfo();
}

function renderStorageInfo() {
  const info = document.getElementById('storage-info');
  const acoes = document.getElementById('storage-acoes');
  if (!info || !acoes) return;

  const suporta = suportaFileSystem();
  const tabArm = document.getElementById('tab-armazenamento');

  let html = '';
  let precisaAtencao = false;

  html += `<div class="storage-linha ativo">
    <span class="status-badge verde">Ativo</span>
    <span>💾 <strong>IndexedDB</strong> — armazenamento principal</span>
  </div>`;

  if (!suporta) {
    precisaAtencao = true;
    html += `<div class="storage-linha inativo">
      <span class="status-badge laranja">Indisponível</span>
      <span>Arquivo local não é suportado. Use <strong>Exportar JSON</strong>.</span>
    </div>`;
  } else if (!fileHandle) {
    precisaAtencao = true;
    html += `<div class="storage-linha inativo">
      <span class="status-badge cinza">Não vinculado</span>
      <span>Clique em <strong>Vincular arquivo</strong>.</span>
    </div>`;
  } else if (autoSalvarAtivo) {
    html += `<div class="storage-linha ativo">
      <span class="status-badge verde">Sincronizando</span>
      <span>💿 <strong>${escapeHtml(fileHandle.name)}</strong> — gravação automática</span>
    </div>`;
  } else {
    precisaAtencao = true;
    html += `<div class="storage-linha inativo">
      <span class="status-badge laranja">Precisa reconectar</span>
      <span><strong>${escapeHtml(fileHandle.name)}</strong> precisa de permissão</span>
    </div>`;
  }

  info.innerHTML = html;

  if (tabArm) {
    if (precisaAtencao) {
      tabArm.classList.add('tab-alerta');
      tabArm.innerHTML = `💾 Armazenamento <span class="alerta-bolinha"></span>`;
    } else {
      tabArm.classList.remove('tab-alerta');
      tabArm.innerHTML = '💾 Armazenamento';
    }
  }

  let botoes = '';
  if (suporta) {
    if (!fileHandle) {
      botoes += `<button class="btn-sucesso" id="btn-vincular">🔗 Vincular arquivo local</button>`;
    } else if (!autoSalvarAtivo) {
      botoes += `<button class="btn-sucesso" id="btn-reconectar">🔓 Reconectar arquivo</button>`;
      botoes += `<button class="btn-secundario" id="btn-trocar-arquivo">🔄 Trocar arquivo</button>`;
    } else {
      botoes += `<button class="btn-secundario" id="btn-desvincular">🚫 Desvincular arquivo</button>`;
    }
  }
  botoes += `<button class="btn-secundario" id="btn-exportar">📤 Exportar JSON</button>`;
  botoes += `<button class="btn-secundario" id="btn-importar">📥 Importar JSON</button>`;

  acoes.innerHTML = botoes;

  const btnVincular = document.getElementById('btn-vincular');
  if (btnVincular) btnVincular.addEventListener('click', escolherArquivoLocal);

  const btnReconectar = document.getElementById('btn-reconectar');
  if (btnReconectar) btnReconectar.addEventListener('click', reconectarArquivo);

  const btnTrocar = document.getElementById('btn-trocar-arquivo');
  if (btnTrocar) btnTrocar.addEventListener('click', async () => {
    fileHandle = null;
    autoSalvarAtivo = false;
    try { await dbDelete(STORE_META, 'fileHandle'); } catch (e) {}
    escolherArquivoLocal();
  });

  const btnDesvincular = document.getElementById('btn-desvincular');
  if (btnDesvincular) btnDesvincular.addEventListener('click', desvincularArquivo);

  document.getElementById('btn-exportar').addEventListener('click', exportarJSON);
  document.getElementById('btn-importar').addEventListener('click', importarJSON);
}

function renderSelects() {
  preencherSelectDisciplinas('select-disciplina-aula');
  preencherSelectDisciplinas('select-disciplina-tema');
  atualizarSelectAulas('select-disciplina-tema', 'select-aula-tema');
}

function preencherSelectDisciplinas(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const valorAtual = sel.value;
  sel.innerHTML = '<option value="">Selecione a disciplina...</option>';
  disciplinas.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.nome;
    sel.appendChild(opt);
  });
  if (valorAtual) sel.value = valorAtual;
}

function atualizarSelectAulas(selectDiscId, selectAulaId) {
  const discId = document.getElementById(selectDiscId).value;
  const selAula = document.getElementById(selectAulaId);
  const valorAtual = selAula.value;

  selAula.innerHTML = '<option value="">Selecione a aula...</option>';

  if (!discId) { selAula.disabled = true; return; }

  const disc = disciplinas.find(d => d.id === discId);
  if (!disc || disc.aulas.length === 0) { selAula.disabled = true; return; }

  selAula.disabled = false;
  disc.aulas.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.titulo;
    selAula.appendChild(opt);
  });

  if (valorAtual) selAula.value = valorAtual;
}

// ============================================================
// BOTÃO DE LINKS
// ============================================================
function renderBotaoLinks(links, tipo, discId, aulaId, temaId) {
  const quantidade = links ? links.length : 0;
  const tem = quantidade > 0;

  const classes = `btn-link ${tem ? 'tem-links' : ''}`;
  const badge = tem ? `<span class="badge-count">${quantidade}</span>` : '';

  const titulo = tem
    ? `${quantidade} link${quantidade > 1 ? 's' : ''} — clique para gerenciar`
    : 'Adicionar links';

  return `<button class="${classes}"
                  data-abrir-links="1"
                  data-links-tipo="${tipo}"
                  data-links-disc="${discId || ''}"
                  data-links-aula="${aulaId || ''}"
                  data-links-tema="${temaId || ''}"
                  title="${titulo}">🔗${badge}</button>`;
}

// ============================================================
// RENDER: LISTAS
// ============================================================
function renderListaDisciplinas() {
  const container = document.getElementById('lista-disciplinas');
  if (!container) return;
  container.innerHTML = '';

  if (disciplinas.length === 0) {
    container.innerHTML = '<p class="vazio">Nenhuma disciplina cadastrada ainda. Vá até a aba <strong>➕ Cadastros</strong> para começar.</p>';
    return;
  }

  disciplinas.forEach(disc => {
    const totalAulas = disc.aulas.length;
    const aulasVistas = disc.aulas.filter(a => a.vista).length;
    const pct = totalAulas ? Math.round((aulasVistas / totalAulas) * 100) : 0;
    const minimizada = disciplinasMinimizadas.has(disc.id);

    const div = document.createElement('div');
    div.className = 'disciplina' + (minimizada ? ' minimizada' : '');
    div.innerHTML = `
      <div class="disciplina-header">
        <div>
          <h3>📚 ${escapeHtml(disc.nome)}</h3>
          <span class="disciplina-info">
            ${disc.professor ? '👨‍🏫 ' + escapeHtml(disc.professor) + ' • ' : ''}
            ${totalAulas} aula(s) • ${aulasVistas} vista(s) (${pct}%)
          </span>
        </div>
        <div class="disciplina-acoes">
          <button class="btn-minimizar-disc"
                  data-minimizar-disc="${disc.id}"
                  title="${minimizada ? 'Expandir' : 'Minimizar'}">
            ${minimizada ? '▼' : '▲'}
          </button>
          ${renderBotaoLinks(disc.links, 'disciplina', disc.id, null, null)}
          <button class="btn-remover" data-remover-disc="${disc.id}" title="Remover disciplina">🗑️</button>
        </div>
      </div>
      <div class="progresso-bar">
        <div class="progresso-fill" style="width: ${pct}%"></div>
      </div>
      <div class="aulas">
        ${totalAulas === 0
          ? '<p class="vazio">Nenhuma aula cadastrada.</p>'
          : disc.aulas.map(aula => renderAula(aula, disc.id)).join('')
        }
      </div>
    `;
    container.appendChild(div);
  });
}

function renderAula(aula, discId) {
  const totalTemas = aula.temas.length;
  const temasVistos = aula.temas.filter(t => t.visto).length;
  const pct = totalTemas ? Math.round((temasVistos / totalTemas) * 100) : 0;
  const minimizada = aulasMinimizadas.has(aula.id);

  return `
    <div class="aula ${aula.vista ? 'vista' : ''} ${minimizada ? 'minimizada' : ''}">
      <div class="aula-header">
        <div class="aula-esquerda">
          <input type="checkbox"
                 data-disc="${discId}"
                 data-aula="${aula.id}"
                 ${aula.vista ? 'checked' : ''}
                 title="Marcar aula como vista">
          <h4>🎬 ${escapeHtml(aula.titulo)}</h4>
        </div>
        <div style="display:flex; gap:4px; align-items:center;">
          <button class="btn-minimizar"
                  data-minimizar-aula="${aula.id}"
                  title="${minimizada ? 'Expandir' : 'Minimizar'}">
            ${minimizada ? '▼' : '▲'}
          </button>
          ${renderBotaoLinks(aula.links, 'aula', discId, aula.id, null)}
          <button class="btn-remover"
                  data-remover-aula="${aula.id}"
                  data-disc-aula="${discId}"
                  title="Excluir aula">🗑️</button>
        </div>
      </div>
      <div class="aula-info">
        ${aula.duracao ? `<span>⏱ ${aula.duracao}min</span>` : ''}
        <span>${temasVistos}/${totalTemas} tema(s) concluído(s)</span>
      </div>
      ${totalTemas > 0 ? `
        <div class="progresso-bar aula-bar">
          <div class="progresso-fill aula-fill" style="width: ${pct}%"></div>
        </div>
      ` : ''}
      <div class="temas">
        ${totalTemas === 0
          ? '<p class="vazio">Nenhum tema cadastrado nesta aula.</p>'
          : aula.temas.map(tema => renderTema(tema, discId, aula.id)).join('')
        }
      </div>
    </div>
  `;
}

function renderTema(tema, discId, aulaId) {
  const links = tema.links || [];
  const primeiroLink = links[0];
  const tipoPrimeiro = primeiroLink ? detectarTipoLink(primeiroLink.url) : null;

  let infoExtra = '';
  if (tipoPrimeiro === 'youtube' && tema.progresso && tema.progresso.segundos > 5) {
    const min = Math.floor(tema.progresso.segundos / 60);
    const seg = String(Math.floor(tema.progresso.segundos % 60)).padStart(2, '0');
    infoExtra = `<span class="tema-assistido-info">⏯ Continuar em ${min}:${seg}</span>`;
  } else if (tema.historico && tema.historico.length > 0) {
    const ultima = new Date(tema.historico[tema.historico.length - 1].em);
    infoExtra = `<span class="tema-assistido-info">👁 Visto em ${formatarData(ultima)}</span>`;
  }

  let botaoAtalho = '';
  if (primeiroLink) {
    if (tipoPrimeiro === 'youtube') {
      botaoAtalho = `<button class="btn-tocar"
                             data-abrir-link-atalho="${primeiroLink.id}"
                             data-atalho-disc="${discId}"
                             data-atalho-aula="${aulaId}"
                             data-atalho-tema="${tema.id}"
                             title="Assistir no player">▶</button>`;
    } else if (tipoPrimeiro === 'pdf-drive') {
      botaoAtalho = `<button class="btn-pdf"
                             data-abrir-link-atalho="${primeiroLink.id}"
                             data-atalho-disc="${discId}"
                             data-atalho-aula="${aulaId}"
                             data-atalho-tema="${tema.id}"
                             title="Ver PDF">📄</button>`;
    } else {
      botaoAtalho = `<button class="btn-link-externo"
                             data-abrir-link-atalho="${primeiroLink.id}"
                             data-atalho-disc="${discId}"
                             data-atalho-aula="${aulaId}"
                             data-atalho-tema="${tema.id}"
                             title="Abrir link">🔗</button>`;
    }
  }

  const temAnotacao = tema.anotacao && tema.anotacao.texto && tema.anotacao.texto.trim() !== '';
  const classeBtnAnot = temAnotacao ? 'tem-anotacao' : '';

  let previewAnotacao = '';
  if (temAnotacao) {
    const primeiraLinha = tema.anotacao.texto.split('\n').find(l => l.trim() !== '') || '';
    const resumo = primeiraLinha.length > 90 ? primeiraLinha.slice(0, 90) + '...' : primeiraLinha;
    previewAnotacao = `
      <div class="tema-preview-anotacao"
           data-abrir-anotacao="${tema.id}"
           data-disc-anotacao="${discId}"
           data-aula-anotacao="${aulaId}"
           title="Ver/editar anotação">📌 ${escapeHtml(resumo)}</div>
    `;
  }

  return `
    <div class="tema ${tema.visto ? 'visto' : ''}">
      <input type="checkbox"
             data-disc="${discId}"
             data-aula-tema="${aulaId}"
             data-tema="${tema.id}"
             ${tema.visto ? 'checked' : ''}>
      <span class="tema-titulo">🏷️ ${escapeHtml(tema.nome)}</span>
      ${infoExtra}
      ${botaoAtalho}
      <button class="btn-anotacao ${classeBtnAnot}"
              data-abrir-anotacao="${tema.id}"
              data-disc-anotacao="${discId}"
              data-aula-anotacao="${aulaId}"
              title="${temAnotacao ? 'Ver/editar anotação' : 'Adicionar anotação'}">📝</button>
      ${renderBotaoLinks(links, 'tema', discId, aulaId, tema.id)}
      <button class="btn-remover"
              data-remover-tema="${tema.id}"
              data-disc-tema="${discId}"
              data-aula-tema="${aulaId}"
              title="Remover tema">✕</button>
    </div>
    ${previewAnotacao}
  `;
}

function renderEstatisticas() {
  const el = document.getElementById('estatisticas');
  if (!el) return;

  const totalDisc = disciplinas.length;
  const totalAulas = disciplinas.reduce((s, d) => s + d.aulas.length, 0);
  const aulasVistas = disciplinas.reduce((s, d) => s + d.aulas.filter(a => a.vista).length, 0);
  const todosTemas = disciplinas.flatMap(d => d.aulas.flatMap(a => a.temas));
  const totalTemas = todosTemas.length;
  const temasVistos = todosTemas.filter(t => t.visto).length;
  const temasComAnotacao = todosTemas.filter(t => t.anotacao && t.anotacao.texto && t.anotacao.texto.trim() !== '').length;
  const totalLinks = disciplinas.reduce((s, d) => s + (d.links?.length || 0), 0)
    + disciplinas.reduce((s, d) => s + d.aulas.reduce((x, a) => x + (a.links?.length || 0), 0), 0)
    + todosTemas.reduce((s, t) => s + (t.links?.length || 0), 0);
  const pct = totalAulas ? Math.round((aulasVistas / totalAulas) * 100) : 0;

  el.innerHTML = `
    <div class="stat-item"><div class="stat-valor">${totalDisc}</div><div class="stat-label">Disciplinas</div></div>
    <div class="stat-item"><div class="stat-valor">${totalAulas}</div><div class="stat-label">Aulas</div></div>
    <div class="stat-item"><div class="stat-valor">${aulasVistas}</div><div class="stat-label">Aulas vistas</div></div>
    <div class="stat-item"><div class="stat-valor">${totalTemas}</div><div class="stat-label">Temas</div></div>
    <div class="stat-item"><div class="stat-valor">${temasVistos}</div><div class="stat-label">Temas vistos</div></div>
    <div class="stat-item"><div class="stat-valor">${temasComAnotacao}</div><div class="stat-label">Com anotação</div></div>
    <div class="stat-item"><div class="stat-valor">${totalLinks}</div><div class="stat-label">Links</div></div>
    <div class="stat-item"><div class="stat-valor">${pct}%</div><div class="stat-label">Progresso</div></div>
  `;
}

// ============================================================
// EVENTOS: FORMULÁRIOS
// ============================================================
document.getElementById('form-disciplina').addEventListener('submit', async e => {
  e.preventDefault();
  const nome = document.getElementById('nome-disciplina').value.trim();
  const professor = document.getElementById('professor-disciplina').value.trim();
  if (!nome) return;

  disciplinas.push({
    id: crypto.randomUUID(),
    nome,
    professor,
    links: [],
    aulas: []
  });

  await salvar();
  render();
  e.target.reset();
  alert('✅ Disciplina cadastrada!');
});

document.getElementById('form-aula').addEventListener('submit', async e => {
  e.preventDefault();
  const discId = document.getElementById('select-disciplina-aula').value;
  const titulo = document.getElementById('titulo-aula').value.trim();
  const duracao = parseInt(document.getElementById('duracao-aula').value) || 0;

  if (!discId || !titulo) return;
  const disc = disciplinas.find(d => d.id === discId);
  if (!disc) return;

  disc.aulas.push({
    id: crypto.randomUUID(),
    titulo,
    duracao,
    vista: false,
    links: [],
    temas: []
  });

  await salvar();
  render();
  e.target.reset();
  alert('✅ Aula cadastrada!');
});

document.getElementById('form-tema').addEventListener('submit', async e => {
  e.preventDefault();
  const discId = document.getElementById('select-disciplina-tema').value;
  const aulaId = document.getElementById('select-aula-tema').value;
  const nome = document.getElementById('nome-tema').value.trim();

  if (!discId || !aulaId || !nome) return;
  const disc = disciplinas.find(d => d.id === discId);
  if (!disc) return;
  const aula = disc.aulas.find(a => a.id === aulaId);
  if (!aula) return;

  aula.temas.push({
    id: crypto.randomUUID(),
    nome,
    links: [],
    visto: false,
    progresso: null,
    historico: [],
    anotacao: null
  });

  await salvar();
  render();
  e.target.reset();
  alert('✅ Tema cadastrado!');
});

document.getElementById('select-disciplina-tema').addEventListener('change', () => {
  document.getElementById('select-aula-tema').disabled = true;
  atualizarSelectAulas('select-disciplina-tema', 'select-aula-tema');
});

// ============================================================
// UTIL: LINKS
// ============================================================
function extrairIdYoutube(url) {
  if (!url) return null;
  const padroes = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/
  ];
  for (const p of padroes) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function extrairIdDrive(url) {
  if (!url) return null;
  const padroes = [
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/uc\?id=([a-zA-Z0-9_-]+)/
  ];
  for (const p of padroes) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function detectarTipoLink(url) {
  if (!url) return 'externo';
  if (extrairIdYoutube(url)) return 'youtube';
  if (extrairIdDrive(url)) return 'pdf-drive';
  return 'externo';
}

function localizarTema(discId, aulaId, temaId) {
  const disc = disciplinas.find(d => d.id === discId);
  if (!disc) return {};
  const aula = disc.aulas.find(a => a.id === aulaId);
  if (!aula) return { disc };
  if (temaId === null || temaId === undefined) return { disc, aula };
  const tema = aula.temas.find(t => t.id === temaId);
  return { disc, aula, tema };
}

// ============================================================
// ABRIR LINK
// ============================================================
function abrirLink(url, linkObj, contexto) {
  const tipo = detectarTipoLink(url);

  if (tipo === 'youtube') {
    const videoId = extrairIdYoutube(url);
    if (videoId) {
      abrirPlayerYoutube(videoId, linkObj, contexto);
      return;
    }
  }

  if (tipo === 'pdf-drive') {
    const fileId = extrairIdDrive(url);
    if (fileId) {
      abrirPdfDrive(fileId, linkObj, contexto);
      return;
    }
  }

  window.open(url, '_blank', 'noopener');
}

// ============================================================
// YOUTUBE PLAYER
// ============================================================
function abrirPlayerYoutube(videoId, linkObj, contexto) {
  const modal = document.getElementById('modal-youtube');
  const container = document.getElementById('player-container');
  const tituloEl = document.getElementById('modal-titulo');
  const linkExterno = document.getElementById('modal-link-externo');
  const checkVisto = document.getElementById('modal-checkbox-visto');
  const statusEl = document.getElementById('modal-status');

  temaAtual = contexto;
  velocidadeAtual = 1;

  const titulo = (linkObj && linkObj.titulo) || 'Vídeo do YouTube';
  tituloEl.textContent = `🎬 ${titulo}`;
  linkExterno.href = `https://www.youtube.com/watch?v=${videoId}`;

  const { tema } = contexto ? localizarTema(contexto.discId, contexto.aulaId, contexto.temaId) : {};
  checkVisto.checked = tema ? !!tema.visto : false;
  statusEl.textContent = '▶ Assistindo...';

  const startSegundos = (tema && tema.progresso) ? Math.floor(tema.progresso.segundos) : 0;

  // Destrói player antigo antes de criar um novo
  if (playerAtual) {
    try { playerAtual.destroy(); } catch (e) {}
    playerAtual = null;
  }

  if (intervaloSalvarProgresso) {
    clearInterval(intervaloSalvarProgresso);
    intervaloSalvarProgresso = null;
  }

  container.innerHTML = '<div id="yt-player"></div>';
  modal.classList.add('ativo');

  // Garante que o DOM está pronto antes de criar o player
  const criarQuandoPronto = () => {
    if (typeof YT === 'undefined' || !YT.Player) {
      carregarApiYoutube(() => criarPlayerYoutube(videoId, startSegundos));
    } else {
      criarPlayerYoutube(videoId, startSegundos);
    }
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(criarQuandoPronto);
  });

  if (tema) registrarAcessoHistorico(tema);
}

function carregarApiYoutube(callback) {
  if (window.ytApiCarregando) {
    window.ytApiCallbacks = window.ytApiCallbacks || [];
    window.ytApiCallbacks.push(callback);
    return;
  }
  window.ytApiCarregando = true;
  window.ytApiCallbacks = [callback];

  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);

  window.onYouTubeIframeAPIReady = function () {
    (window.ytApiCallbacks || []).forEach(cb => cb());
    window.ytApiCallbacks = [];
    window.ytApiCarregando = false;
  };
}

// ⭐ FUNÇÃO CORRIGIDA — sem origin fixo, evita erro postMessage
function criarPlayerYoutube(videoId, startSegundos) {
  const container = document.getElementById('yt-player');
  if (!container) {
    console.error('❌ Container yt-player não encontrado');
    return;
  }

  // Destrói instância anterior se existir
  if (playerAtual) {
    try { playerAtual.destroy(); } catch (e) {}
    playerAtual = null;
  }

  // Detecta a origem REAL da página
  // - Em file:/// o origin é "null" (string) — não passa nada
  // - Em http:// ou https:// passa a URL real
  const originReal = window.location.origin;
  const temOriginValida = originReal && originReal !== 'null' && originReal !== 'file://';

  const playerVars = {
    autoplay: 1,
    rel: 0,
    start: startSegundos || 0,
    modestbranding: 1,
    playsinline: 1,
    enablejsapi: 1
  };

  // Só passa origin se for válida (evita erro de postMessage em file://)
  if (temOriginValida) {
    playerVars.origin = originReal;
  }

  console.log('🎬 Criando player YouTube:', {
    videoId,
    origem: temOriginValida ? originReal : '(file:// — sem origin)',
    playerVars
  });

  playerAtual = new YT.Player('yt-player', {
    videoId: videoId,
    playerVars: playerVars,
    events: {
      onReady: e => {
        console.log('✅ Player pronto');
        try { e.target.setPlaybackRate(velocidadeAtual); } catch (err) {}
      },
      onStateChange: onPlayerStateChange,
      onError: e => {
        console.error('❌ Erro do YouTube API:', e.data);
        const statusEl = document.getElementById('modal-status');
        if (statusEl) {
          let msg = '⚠️ Erro ao carregar (código ' + e.data + ')';
          if (e.data === 2) msg = '⚠️ ID do vídeo inválido';
          else if (e.data === 5) msg = '⚠️ Erro no player HTML5';
          else if (e.data === 100) msg = '⚠️ Vídeo não encontrado ou privado';
          else if (e.data === 101 || e.data === 150) msg = '⚠️ Vídeo não permite reprodução embutida';
          else if (e.data === 153) msg = '⚠️ Erro de configuração — use "Abrir no YouTube ↗"';
          statusEl.textContent = msg;
        }
      }
    }
  });

  intervaloSalvarProgresso = setInterval(salvarProgressoAtual, 5000);
}

function onPlayerStateChange(event) {
  const statusEl = document.getElementById('modal-status');
  if (event.data === YT.PlayerState.PLAYING) {
    statusEl.textContent = '▶ Assistindo...';
  } else if (event.data === YT.PlayerState.PAUSED) {
    statusEl.textContent = '⏸ Pausado';
  } else if (event.data === YT.PlayerState.ENDED) {
    statusEl.textContent = '✅ Vídeo concluído';
    marcarTemaComoVistoAoTerminar();
  }
}

async function marcarTemaComoVistoAoTerminar() {
  if (!temaAtual) return;
  const { tema } = localizarTema(temaAtual.discId, temaAtual.aulaId, temaAtual.temaId);
  if (!tema) return;
  tema.visto = true;
  tema.progresso = null;
  document.getElementById('modal-checkbox-visto').checked = true;
  await salvar();
  render();
}

async function salvarProgressoAtual() {
  if (!playerAtual || !temaAtual) return;
  try {
    const segundos = playerAtual.getCurrentTime();
    const duracao = playerAtual.getDuration();
    if (duracao > 0 && segundos >= duracao - 3) return;
    if (segundos > 5) {
      const { tema } = localizarTema(temaAtual.discId, temaAtual.aulaId, temaAtual.temaId);
      if (!tema) return;
      tema.progresso = { segundos, atualizadoEm: new Date().toISOString() };
      await salvar();
    }
  } catch (e) {}
}

function fecharPlayerYoutube() {
  const modal = document.getElementById('modal-youtube');
  const container = document.getElementById('player-container');

  salvarProgressoAtual();

  if (playerAtual) {
    try { playerAtual.destroy(); } catch (e) {}
    playerAtual = null;
  }

  if (intervaloSalvarProgresso) {
    clearInterval(intervaloSalvarProgresso);
    intervaloSalvarProgresso = null;
  }

  container.innerHTML = '';
  modal.classList.remove('ativo');
  temaAtual = null;
  render();
}

// ============================================================
// PDF PLAYER
// ============================================================
function abrirPdfDrive(fileId, linkObj, contexto) {
  const modal = document.getElementById('modal-pdf');
  const container = document.getElementById('pdf-container');
  const tituloEl = document.getElementById('modal-pdf-titulo');
  const linkExterno = document.getElementById('modal-pdf-link-externo');
  const checkVisto = document.getElementById('modal-pdf-checkbox-visto');

  temaAtual = contexto;

  const titulo = (linkObj && linkObj.titulo) || 'PDF';
  tituloEl.textContent = `📄 ${titulo}`;
  linkExterno.href = `https://drive.google.com/file/d/${fileId}/view`;

  const { tema } = contexto ? localizarTema(contexto.discId, contexto.aulaId, contexto.temaId) : {};
  checkVisto.checked = tema ? !!tema.visto : false;

  container.innerHTML = `
    <iframe
      src="https://drive.google.com/file/d/${fileId}/preview"
      title="${escapeHtml(titulo)}"
      allow="autoplay"
      allowfullscreen>
    </iframe>
  `;

  modal.classList.add('ativo');
  if (tema) registrarAcessoHistorico(tema);
}

function fecharPdfDrive() {
  const modal = document.getElementById('modal-pdf');
  const container = document.getElementById('pdf-container');
  container.innerHTML = '';
  modal.classList.remove('ativo');
  temaAtual = null;
  render();
}

// ============================================================
// ANOTAÇÃO
// ============================================================
function abrirModalAnotacao(temaId, discId, aulaId) {
  const { disc, aula, tema } = localizarTema(discId, aulaId, temaId);
  if (!tema) return;

  temaAtualAnotacao = { discId, aulaId, temaId };

  const modal = document.getElementById('modal-anotacao');
  const titulo = document.getElementById('modal-anotacao-titulo');
  const contexto = document.getElementById('modal-anotacao-contexto');
  const texto = document.getElementById('modal-anotacao-texto');
  const rodape = document.getElementById('modal-anotacao-rodape');

  titulo.textContent = `📝 ${tema.nome}`;
  contexto.textContent = `📚 ${disc.nome} → 🎬 ${aula.titulo}`;
  texto.value = (tema.anotacao && tema.anotacao.texto) || '';

  if (tema.anotacao && tema.anotacao.atualizadoEm) {
    rodape.textContent = `Última edição: ${formatarData(new Date(tema.anotacao.atualizadoEm))}`;
  } else {
    rodape.textContent = 'Nenhuma anotação ainda';
  }

  modal.classList.add('ativo');
  setTimeout(() => texto.focus(), 100);
}

function fecharModalAnotacao(salvarDados = true) {
  if (!temaAtualAnotacao) return;

  const textoEl = document.getElementById('modal-anotacao-texto');
  const texto = textoEl.value;

  const { tema } = localizarTema(temaAtualAnotacao.discId, temaAtualAnotacao.aulaId, temaAtualAnotacao.temaId);

  if (tema && salvarDados) {
    const textoLimpo = texto.trim();
    if (textoLimpo === '') {
      tema.anotacao = null;
    } else {
      tema.anotacao = { texto, atualizadoEm: new Date().toISOString() };
    }
    salvar().then(() => render());
  }

  document.getElementById('modal-anotacao').classList.remove('ativo');
  temaAtualAnotacao = null;
}

document.getElementById('modal-anotacao-fechar').addEventListener('click', () => fecharModalAnotacao(true));
document.getElementById('modal-anotacao').addEventListener('click', e => {
  if (e.target.id === 'modal-anotacao') fecharModalAnotacao(true);
});
document.getElementById('modal-anotacao-limpar').addEventListener('click', () => {
  if (!temaAtualAnotacao) return;
  if (confirm('Limpar a anotação?')) {
    document.getElementById('modal-anotacao-texto').value = '';
    fecharModalAnotacao(true);
  }
});

// ============================================================
// MODAL DE LINKS
// ============================================================
function abrirModalLinks(tipo, discId, aulaId, temaId) {
  linksModalInfo = { tipo, discId, aulaId, temaId };

  const modal = document.getElementById('modal-links');
  const tituloEl = document.getElementById('modal-links-titulo');
  const contextoEl = document.getElementById('modal-links-contexto');

  let nome = '';
  let contexto = '';

  if (tipo === 'disciplina') {
    const disc = disciplinas.find(d => d.id === discId);
    if (!disc) return;
    nome = disc.nome;
    contexto = `📚 Disciplina: ${disc.nome}`;
  } else if (tipo === 'aula') {
    const disc = disciplinas.find(d => d.id === discId);
    if (!disc) return;
    const aula = disc.aulas.find(a => a.id === aulaId);
    if (!aula) return;
    nome = aula.titulo;
    contexto = `📚 ${disc.nome} → 🎬 ${aula.titulo}`;
  } else if (tipo === 'tema') {
    const { disc, aula, tema } = localizarTema(discId, aulaId, temaId);
    if (!tema) return;
    nome = tema.nome;
    contexto = `📚 ${disc.nome} → 🎬 ${aula.titulo} → 🏷️ ${tema.nome}`;
  }

  tituloEl.textContent = `🔗 Links — ${nome}`;
  contextoEl.textContent = contexto;

  renderLinksModal();

  document.getElementById('novo-link-titulo').value = '';
  document.getElementById('novo-link-url').value = '';
  document.getElementById('novo-link-tipo').textContent = 'Aguardando link...';
  novoLinkTipoDetectado = null;

  modal.classList.add('ativo');
}

function getLinksDoItem(info) {
  if (!info) return [];
  const { tipo, discId, aulaId, temaId } = info;

  if (tipo === 'disciplina') {
    const disc = disciplinas.find(d => d.id === discId);
    return disc ? (disc.links || []) : [];
  }
  if (tipo === 'aula') {
    const disc = disciplinas.find(d => d.id === discId);
    if (!disc) return [];
    const aula = disc.aulas.find(a => a.id === aulaId);
    return aula ? (aula.links || []) : [];
  }
  if (tipo === 'tema') {
    const { tema } = localizarTema(discId, aulaId, temaId);
    return tema ? (tema.links || []) : [];
  }
  return [];
}

function renderLinksModal() {
  const container = document.getElementById('modal-links-lista');
  const links = getLinksDoItem(linksModalInfo);

  if (links.length === 0) {
    container.innerHTML = '<p class="vazio" style="padding: 20px;">Nenhum link cadastrado ainda. Adicione o primeiro abaixo 👇</p>';
    return;
  }

  container.innerHTML = links.map((link, idx) => {
    const tipoLink = detectarTipoLink(link.url);

    let iconeTipo = '🔗';
    let labelBotaoAbrir = '🔗 Abrir';

    if (tipoLink === 'youtube') {
      iconeTipo = '▶';
      labelBotaoAbrir = '▶ Abrir';
    } else if (tipoLink === 'pdf-drive') {
      iconeTipo = '📄';
      labelBotaoAbrir = '📄 Abrir';
    }

    const tituloMostrar = (link.titulo && link.titulo.trim())
      ? link.titulo
      : (tipoLink === 'youtube' ? 'Vídeo do YouTube' : tipoLink === 'pdf-drive' ? 'PDF do Drive' : 'Link');

    return `
      <div class="link-item">
        <div class="link-item-header">
          <span style="font-size: 1.1rem;">${iconeTipo}</span>
          <span class="link-item-titulo">${escapeHtml(tituloMostrar)}</span>
        </div>
        <div class="link-item-url">${escapeHtml(link.url)}</div>
        <div class="link-item-acoes">
          <button class="btn-abrir-link-item"
                  data-acao-link="abrir"
                  data-link-id="${link.id}">${labelBotaoAbrir}</button>
          <button class="btn-editar-link"
                  data-acao-link="editar"
                  data-link-id="${link.id}">✏️ Editar</button>
          <button class="btn-excluir-link"
                  data-acao-link="excluir"
                  data-link-id="${link.id}">🗑️ Excluir</button>
        </div>
      </div>
    `;
  }).join('');
}

function fecharModalLinks() {
  document.getElementById('modal-links').classList.remove('ativo');
  linksModalInfo = null;
  novoLinkTipoDetectado = null;
  render();
}

document.getElementById('modal-links-fechar').addEventListener('click', fecharModalLinks);
document.getElementById('modal-links').addEventListener('click', e => {
  if (e.target.id === 'modal-links') fecharModalLinks();
});

document.getElementById('novo-link-url').addEventListener('input', e => {
  const url = e.target.value.trim();
  const tipoEl = document.getElementById('novo-link-tipo');

  if (!url) {
    tipoEl.textContent = 'Aguardando link...';
    tipoEl.style.color = 'var(--texto-secundario)';
    novoLinkTipoDetectado = null;
    return;
  }

  const tipo = detectarTipoLink(url);
  novoLinkTipoDetectado = tipo;

  if (tipo === 'youtube') {
    tipoEl.innerHTML = 'Tipo detectado: <strong style="color: var(--laranja);">▶ YouTube</strong>';
  } else if (tipo === 'pdf-drive') {
    tipoEl.innerHTML = 'Tipo detectado: <strong style="color: var(--azul-principal);">📄 PDF do Google Drive</strong>';
  } else {
    tipoEl.innerHTML = 'Tipo detectado: <strong style="color: var(--azul-principal);">🔗 Link externo</strong>';
  }
});

document.getElementById('btn-adicionar-link').addEventListener('click', async () => {
  if (!linksModalInfo) return;

  const titulo = document.getElementById('novo-link-titulo').value.trim();
  const url = document.getElementById('novo-link-url').value.trim();

  if (!url) {
    alert('Cole um link antes de adicionar.');
    return;
  }

  const novoLink = { id: crypto.randomUUID(), url, titulo };

  const { tipo, discId, aulaId, temaId } = linksModalInfo;

  if (tipo === 'disciplina') {
    const disc = disciplinas.find(d => d.id === discId);
    if (disc) {
      if (!Array.isArray(disc.links)) disc.links = [];
      disc.links.push(novoLink);
    }
  } else if (tipo === 'aula') {
    const disc = disciplinas.find(d => d.id === discId);
    if (disc) {
      const aula = disc.aulas.find(a => a.id === aulaId);
      if (aula) {
        if (!Array.isArray(aula.links)) aula.links = [];
        aula.links.push(novoLink);
      }
    }
  } else if (tipo === 'tema') {
    const { tema } = localizarTema(discId, aulaId, temaId);
    if (tema) {
      if (!Array.isArray(tema.links)) tema.links = [];
      tema.links.push(novoLink);
    }
  }

  await salvar();

  document.getElementById('novo-link-titulo').value = '';
  document.getElementById('novo-link-url').value = '';
  document.getElementById('novo-link-tipo').textContent = 'Aguardando link...';
  novoLinkTipoDetectado = null;

  renderLinksModal();
  renderListaDisciplinas();
});

document.getElementById('modal-links-lista').addEventListener('click', async e => {
  const btn = e.target.closest('[data-acao-link]');
  if (!btn) return;

  const acao = btn.dataset.acaoLink;
  const linkId = btn.dataset.linkId;

  const links = getLinksDoItem(linksModalInfo);
  const link = links.find(l => l.id === linkId);
  if (!link) return;

  if (acao === 'abrir') {
    let contexto = null;
    if (linksModalInfo.tipo === 'tema') {
      contexto = {
        discId: linksModalInfo.discId,
        aulaId: linksModalInfo.aulaId,
        temaId: linksModalInfo.temaId
      };
    }
    abrirLink(link.url, link, contexto);
    return;
  }

  if (acao === 'editar') {
    const novoTitulo = prompt('Novo título (deixe vazio para remover):', link.titulo || '');
    if (novoTitulo === null) return;

    const novaUrl = prompt('Novo link:', link.url);
    if (novaUrl === null || !novaUrl.trim()) return;

    link.titulo = novoTitulo.trim();
    link.url = novaUrl.trim();

    await salvar();
    renderLinksModal();
    renderListaDisciplinas();
    return;
  }

  if (acao === 'excluir') {
    if (!confirm('Excluir este link?')) return;

    const { tipo, discId, aulaId, temaId } = linksModalInfo;

    if (tipo === 'disciplina') {
      const disc = disciplinas.find(d => d.id === discId);
      if (disc) disc.links = disc.links.filter(l => l.id !== linkId);
    } else if (tipo === 'aula') {
      const disc = disciplinas.find(d => d.id === discId);
      if (disc) {
        const aula = disc.aulas.find(a => a.id === aulaId);
        if (aula) aula.links = aula.links.filter(l => l.id !== linkId);
      }
    } else if (tipo === 'tema') {
      const { tema } = localizarTema(discId, aulaId, temaId);
      if (tema) tema.links = tema.links.filter(l => l.id !== linkId);
    }

    await salvar();
    renderLinksModal();
    renderListaDisciplinas();
  }
});

// ============================================================
// HISTÓRICO
// ============================================================
async function registrarAcessoHistorico(tema) {
  if (!tema || !tema.id) return;
  tema.historico = tema.historico || [];
  tema.historico.push({ em: new Date().toISOString() });
  if (tema.historico.length > 20) tema.historico = tema.historico.slice(-20);
  await salvar();
}

// ============================================================
// CLICK DA LISTA
// ============================================================
document.getElementById('lista-disciplinas').addEventListener('click', async e => {
  const btnLinks = e.target.closest('[data-abrir-links]');
  if (btnLinks) {
    abrirModalLinks(
      btnLinks.dataset.linksTipo,
      btnLinks.dataset.linksDisc,
      btnLinks.dataset.linksAula,
      btnLinks.dataset.linksTema
    );
    return;
  }

  const btnAtalho = e.target.closest('[data-abrir-link-atalho]');
  if (btnAtalho) {
    const linkId = btnAtalho.dataset.abrirLinkAtalho;
    const discId = btnAtalho.dataset.atalhoDisc;
    const aulaId = btnAtalho.dataset.atalhoAula;
    const temaId = btnAtalho.dataset.atalhoTema;

    const { tema } = localizarTema(discId, aulaId, temaId);
    if (!tema) return;

    const link = (tema.links || []).find(l => l.id === linkId);
    if (!link) return;

    abrirLink(link.url, link, { discId, aulaId, temaId });
    return;
  }

  const btnAnot = e.target.closest('[data-abrir-anotacao]');
  if (btnAnot) {
    abrirModalAnotacao(
      btnAnot.dataset.abrirAnotacao,
      btnAnot.dataset.discAnotacao,
      btnAnot.dataset.aulaAnotacao
    );
    return;
  }

  const btnMinDisc = e.target.closest('[data-minimizar-disc]');
  if (btnMinDisc) {
    const id = btnMinDisc.dataset.minimizarDisc;
    if (disciplinasMinimizadas.has(id)) disciplinasMinimizadas.delete(id);
    else disciplinasMinimizadas.add(id);
    render();
    return;
  }

  const btnMin = e.target.closest('[data-minimizar-aula]');
  if (btnMin) {
    const id = btnMin.dataset.minimizarAula;
    if (aulasMinimizadas.has(id)) aulasMinimizadas.delete(id);
    else aulasMinimizadas.add(id);
    render();
    return;
  }

  const btnDisc = e.target.closest('[data-remover-disc]');
  if (btnDisc) {
    const id = btnDisc.dataset.removerDisc;
    const disc = disciplinas.find(d => d.id === id);
    if (disc && confirm(`Remover "${disc.nome}" com tudo dentro?`)) {
      disciplinas = disciplinas.filter(d => d.id !== id);
      disciplinasMinimizadas.delete(id);
      await salvar();
      render();
    }
    return;
  }

  const btnAula = e.target.closest('[data-remover-aula]');
  if (btnAula) {
    const aulaId = btnAula.dataset.removerAula;
    const discId = btnAula.dataset.discAula;
    const disc = disciplinas.find(d => d.id === discId);
    if (disc) {
      const aula = disc.aulas.find(a => a.id === aulaId);
      if (aula && confirm(`Excluir aula "${aula.titulo}"?`)) {
        disc.aulas = disc.aulas.filter(a => a.id !== aulaId);
        aulasMinimizadas.delete(aulaId);
        await salvar();
        render();
      }
    }
    return;
  }

  const btnTema = e.target.closest('[data-remover-tema]');
  if (btnTema) {
    const temaId = btnTema.dataset.removerTema;
    const discId = btnTema.dataset.discTema;
    const aulaId = btnTema.dataset.aulaTema;
    const disc = disciplinas.find(d => d.id === discId);
    if (disc) {
      const aula = disc.aulas.find(a => a.id === aulaId);
      if (aula) {
        aula.temas = aula.temas.filter(t => t.id !== temaId);
        await salvar();
        render();
      }
    }
  }
});

document.getElementById('lista-disciplinas').addEventListener('change', async e => {
  if (e.target.matches('input[type="checkbox"][data-aula]')) {
    const { aula } = localizarTema(e.target.dataset.disc, e.target.dataset.aula, null);
    if (!aula) return;
    aula.vista = e.target.checked;
    await salvar();
    render();
    return;
  }
  if (e.target.matches('input[type="checkbox"][data-tema]')) {
    const { tema } = localizarTema(e.target.dataset.disc, e.target.dataset.aulaTema, e.target.dataset.tema);
    if (!tema) return;
    tema.visto = e.target.checked;
    await salvar();
    render();
  }
});

document.getElementById('btn-limpar').addEventListener('click', async () => {
  if (confirm('Apagar TODAS as disciplinas, aulas e temas?')) {
    disciplinas = [];
    aulasMinimizadas.clear();
    disciplinasMinimizadas.clear();
    await salvar();
    render();
  }
});

// ============================================================
// MODAIS GLOBAIS: FECHAR
// ============================================================
document.getElementById('modal-fechar').addEventListener('click', fecharPlayerYoutube);
document.getElementById('modal-youtube').addEventListener('click', e => {
  if (e.target.id === 'modal-youtube') fecharPlayerYoutube();
});

document.getElementById('modal-pdf-fechar').addEventListener('click', fecharPdfDrive);
document.getElementById('modal-pdf').addEventListener('click', e => {
  if (e.target.id === 'modal-pdf') fecharPdfDrive();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('modal-youtube').classList.contains('ativo')) fecharPlayerYoutube();
    if (document.getElementById('modal-pdf').classList.contains('ativo')) fecharPdfDrive();
    if (document.getElementById('modal-import').classList.contains('ativo')) fecharModalImport();
    if (document.getElementById('modal-anotacao').classList.contains('ativo')) fecharModalAnotacao(true);
    if (document.getElementById('modal-links').classList.contains('ativo')) fecharModalLinks();
  }
});

document.getElementById('modal-checkbox-visto').addEventListener('change', async e => {
  if (!temaAtual) return;
  const { tema } = localizarTema(temaAtual.discId, temaAtual.aulaId, temaAtual.temaId);
  if (!tema) return;
  tema.visto = e.target.checked;
  if (tema.visto) tema.progresso = null;
  await salvar();
});

document.getElementById('modal-pdf-checkbox-visto').addEventListener('change', async e => {
  if (!temaAtual) return;
  const { tema } = localizarTema(temaAtual.discId, temaAtual.aulaId, temaAtual.temaId);
  if (!tema) return;
  tema.visto = e.target.checked;
  await salvar();
});

document.getElementById('btn-velocidade').addEventListener('click', () => {
  const velocidades = [1, 1.25, 1.5, 1.75, 2, 0.5, 0.75];
  const idx = velocidades.indexOf(velocidadeAtual);
  velocidadeAtual = velocidades[(idx + 1) % velocidades.length];
  document.getElementById('btn-velocidade').textContent = velocidadeAtual + 'x';
  if (playerAtual && playerAtual.setPlaybackRate) {
    try { playerAtual.setPlaybackRate(velocidadeAtual); } catch (e) {}
  }
});

// ============================================================
// NAVEGAÇÃO
// ============================================================
function trocarTela(nomeTela) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('ativa', t.dataset.tab === nomeTela);
  });
  document.querySelectorAll('.tela').forEach(t => t.classList.remove('ativa'));
  const tela = document.getElementById('tela-' + nomeTela);
  if (tela) tela.classList.add('ativa');

  if (nomeTela === 'disciplinas') renderListaDisciplinas();
  else if (nomeTela === 'cadastros') renderSelects();
  else if (nomeTela === 'progresso') renderEstatisticas();
  else if (nomeTela === 'armazenamento') renderStorageInfo();

  try { sessionStorage.setItem('abaAtiva', nomeTela); } catch (e) {}
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => trocarTela(tab.dataset.tab));
});

// ============================================================
// CSV
// ============================================================
function abrirModalImport() {
  document.getElementById('modal-import').classList.add('ativo');
  document.getElementById('import-arquivo').value = '';
  document.getElementById('import-texto').value = '';
  document.getElementById('import-preview').innerHTML = '';
  document.getElementById('btn-confirmar-import').disabled = true;
  importPreviewData = null;
}

function fecharModalImport() {
  document.getElementById('modal-import').classList.remove('ativo');
  importPreviewData = null;
}

document.getElementById('btn-abrir-import').addEventListener('click', abrirModalImport);
document.getElementById('modal-import-fechar').addEventListener('click', fecharModalImport);
document.getElementById('modal-import-cancelar').addEventListener('click', fecharModalImport);
document.getElementById('modal-import').addEventListener('click', e => {
  if (e.target.id === 'modal-import') fecharModalImport();
});

document.getElementById('import-arquivo').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const texto = await file.text();
    document.getElementById('import-texto').value = texto;
  } catch (err) {
    alert('Erro: ' + err.message);
  }
});

function detectarSeparador(linha) {
  let countV = 0, countPv = 0, dentroAspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') {
      if (dentroAspas && linha[i + 1] === '"') { i++; continue; }
      dentroAspas = !dentroAspas;
    } else if (!dentroAspas) {
      if (c === ',') countV++;
      if (c === ';') countPv++;
    }
  }
  if (countPv > 0 && countV === 0) return ';';
  if (countV > 0 && countPv === 0) return ',';
  return countPv > countV ? ';' : ',';
}

function parseLinhaCSV(linha, separador) {
  const campos = [];
  let campoAtual = '';
  let dentroAspas = false;
  let i = 0;

  while (i < linha.length) {
    const char = linha[i];
    if (char === '"') {
      if (dentroAspas && linha[i + 1] === '"') {
        campoAtual += '"';
        i += 2;
        continue;
      }
      dentroAspas = !dentroAspas;
      i++;
      continue;
    }
    if (char === separador && !dentroAspas) {
      campos.push(campoAtual.trim());
      campoAtual = '';
      i++;
      continue;
    }
    campoAtual += char;
    i++;
  }
  campos.push(campoAtual.trim());
  return campos;
}

function parseLinks(str) {
  if (!str || !str.trim()) return [];
  return str.split(';;').map(parte => {
    const p = parte.trim();
    if (!p) return null;
    const [titulo, url] = p.split('|').map(x => (x || '').trim());
    if (!url) {
      return { id: crypto.randomUUID(), url: p, titulo: '' };
    }
    return { id: crypto.randomUUID(), url, titulo };
  }).filter(Boolean);
}

function parseCSV(texto) {
  texto = texto.replace(/^\uFEFF/, '');
  const linhas = texto.split(/\r?\n|\r/).filter(l => l.trim() !== '');

  if (linhas.length < 2) throw new Error('CSV precisa ter cabeçalho e dados.');

  const separador = detectarSeparador(linhas[0]);
  const cabecalho = parseLinhaCSV(linhas[0], separador).map(c => c.toLowerCase().trim());

  const colunasNecessarias = ['disciplina', 'aula', 'tema'];
  for (const col of colunasNecessarias) {
    if (!cabecalho.includes(col)) throw new Error(`Coluna obrigatória ausente: "${col}"`);
  }

  const registros = [];
  const erros = [];

  for (let i = 1; i < linhas.length; i++) {
    const campos = parseLinhaCSV(linhas[i], separador);
    const reg = {};
    cabecalho.forEach((col, idx) => { reg[col] = (campos[idx] || '').trim(); });

    if (!reg.disciplina) { erros.push({ linha: i + 1, motivo: 'Disciplina vazia' }); continue; }
    if (!reg.aula) { erros.push({ linha: i + 1, motivo: 'Aula vazia' }); continue; }
    if (!reg.tema) { erros.push({ linha: i + 1, motivo: 'Tema vazio' }); continue; }

    registros.push({
      disciplina: reg.disciplina,
      professor: reg.professor || '',
      aula: reg.aula,
      tema: reg.tema,
      links: parseLinks(reg.links || ''),
      anotacao: reg.anotacao || '',
      links_disciplina: parseLinks(reg.links_disciplina || ''),
      links_aula: parseLinks(reg.links_aula || ''),
      linhaOriginal: i + 1
    });
  }

  return { registros, erros };
}

document.getElementById('btn-preview-import').addEventListener('click', () => {
  const texto = document.getElementById('import-texto').value.trim();
  if (!texto) { alert('Cole o conteúdo do CSV primeiro.'); return; }

  try {
    const { registros, erros } = parseCSV(texto);

    const disciplinasUnicas = new Set();
    const aulasUnicas = new Set();
    let totalLinks = 0;
    registros.forEach(r => {
      disciplinasUnicas.add(r.disciplina);
      aulasUnicas.add(`${r.disciplina}|||${r.aula}`);
      totalLinks += r.links.length;
    });

    let html = `
      <div class="preview-box">
        <div class="preview-stats">
          <div class="preview-stat"><div class="preview-stat-valor">${disciplinasUnicas.size}</div><div class="preview-stat-label">Disciplinas</div></div>
          <div class="preview-stat"><div class="preview-stat-valor">${aulasUnicas.size}</div><div class="preview-stat-label">Aulas</div></div>
          <div class="preview-stat"><div class="preview-stat-valor">${registros.length}</div><div class="preview-stat-label">Temas</div></div>
          <div class="preview-stat"><div class="preview-stat-valor">${totalLinks}</div><div class="preview-stat-label">Links</div></div>
        </div>
        <h5>✅ Válidos (${registros.length})</h5>
        <div style="max-height: 150px; overflow-y: auto; margin-bottom: 12px;">
          ${registros.slice(0, 20).map(r => `
            <div class="preview-item">
              📚 ${escapeHtml(r.disciplina)} → 🎬 ${escapeHtml(r.aula)} → 🏷️ ${escapeHtml(r.tema)}
              ${r.links.length > 0 ? `<span style="color: var(--texto-secundario); font-size: 0.75rem;">[${r.links.length} link(s)]</span>` : ''}
            </div>
          `).join('')}
          ${registros.length > 20 ? `<div class="preview-item" style="color: var(--texto-secundario); font-style: italic;">... e mais ${registros.length - 20}</div>` : ''}
        </div>
        ${erros.length > 0 ? `
          <h5 style="color: var(--vermelho);">⚠️ Linhas ignoradas (${erros.length})</h5>
          <div style="max-height: 100px; overflow-y: auto;">
            ${erros.slice(0, 10).map(e => `<div class="preview-item-erro">Linha ${e.linha}: ${escapeHtml(e.motivo)}</div>`).join('')}
          </div>
        ` : ''}
      </div>
    `;

    document.getElementById('import-preview').innerHTML = html;
    importPreviewData = registros;
    document.getElementById('btn-confirmar-import').disabled = registros.length === 0;
  } catch (err) {
    document.getElementById('import-preview').innerHTML = `
      <div class="preview-box" style="border-color: var(--vermelho);">
        <div class="preview-item-erro">❌ ${escapeHtml(err.message)}</div>
      </div>`;
    importPreviewData = null;
    document.getElementById('btn-confirmar-import').disabled = true;
  }
});

document.getElementById('btn-confirmar-import').addEventListener('click', async () => {
  if (!importPreviewData || importPreviewData.length === 0) return;

  const modo = document.querySelector('input[name="modo-import"]:checked').value;

  if (modo === 'substituir') {
    if (!confirm(`⚠️ Substituir TODOS os dados atuais (${disciplinas.length} disciplina(s))?`)) return;
    disciplinas = [];
  }

  const mapa = new Map();

  for (const reg of importPreviewData) {
    const keyDisc = reg.disciplina.toLowerCase();

    if (!mapa.has(keyDisc)) {
      mapa.set(keyDisc, {
        nome: reg.disciplina,
        professor: reg.professor,
        links: reg.links_disciplina || [],
        aulas: new Map()
      });
    }

    const discObj = mapa.get(keyDisc);
    const keyAula = reg.aula.toLowerCase();

    if (!discObj.aulas.has(keyAula)) {
      const existente = disciplinas.find(d => d.nome.toLowerCase() === keyDisc);
      let aulaExistente = null;
      if (existente) aulaExistente = existente.aulas.find(a => a.titulo.toLowerCase() === keyAula);

      discObj.aulas.set(keyAula, {
        id: aulaExistente ? aulaExistente.id : crypto.randomUUID(),
        titulo: reg.aula,
        duracao: aulaExistente ? aulaExistente.duracao : 0,
        vista: aulaExistente ? aulaExistente.vista : false,
        links: reg.links_aula.length > 0 ? reg.links_aula : (aulaExistente ? aulaExistente.links : []),
        temas: aulaExistente ? [...aulaExistente.temas] : []
      });
    }

    const aulaObj = discObj.aulas.get(keyAula);
    const temaExiste = aulaObj.temas.some(t => t.nome.toLowerCase() === reg.tema.toLowerCase());
    if (!temaExiste) {
      aulaObj.temas.push({
        id: crypto.randomUUID(),
        nome: reg.tema,
        links: reg.links,
        visto: false,
        progresso: null,
        historico: [],
        anotacao: reg.anotacao ? { texto: reg.anotacao, atualizadoEm: new Date().toISOString() } : null
      });
    }
  }

  const novasDisciplinas = [];
  for (const [key, obj] of mapa) {
    const existente = disciplinas.find(d => d.nome.toLowerCase() === key);
    if (existente) {
      existente.aulas = Array.from(obj.aulas.values());
      if (obj.professor) existente.professor = obj.professor;
      if (obj.links.length > 0) existente.links = obj.links;
    } else {
      novasDisciplinas.push({
        id: crypto.randomUUID(),
        nome: obj.nome,
        professor: obj.professor,
        links: obj.links || [],
        aulas: Array.from(obj.aulas.values())
      });
    }
  }

  disciplinas = [...disciplinas, ...novasDisciplinas];

  await salvar();
  render();
  fecharModalImport();

  alert(`✅ Importação concluída!\n\n📚 Novas disciplinas: ${novasDisciplinas.length}\n🏷️ Temas processados: ${importPreviewData.length}`);
  trocarTela('disciplinas');
});

document.getElementById('btn-exportar-csv').addEventListener('click', () => {
  if (disciplinas.length === 0) { alert('Nada para exportar.'); return; }

  const linhas = ['disciplina,professor,aula,tema,links,anotacao,links_disciplina,links_aula'];

  const esc = (v) => {
    const s = String(v || '');
    if (s.includes(',') || s.includes(';') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const serializarLinks = (links) => {
    if (!links || links.length === 0) return '';
    return links.map(l => {
      const t = (l.titulo || '').trim();
      return t ? `${t}|${l.url}` : l.url;
    }).join(';;');
  };

  disciplinas.forEach(disc => {
    disc.aulas.forEach(aula => {
      if (aula.temas.length === 0) {
        linhas.push([
          esc(disc.nome), esc(disc.professor), esc(aula.titulo),
          esc('(sem tema)'), esc(''), esc(''),
          esc(serializarLinks(disc.links)), esc(serializarLinks(aula.links))
        ].join(','));
      } else {
        aula.temas.forEach(tema => {
          linhas.push([
            esc(disc.nome), esc(disc.professor), esc(aula.titulo), esc(tema.nome),
            esc(serializarLinks(tema.links)),
            esc(tema.anotacao && tema.anotacao.texto ? tema.anotacao.texto : ''),
            esc(serializarLinks(disc.links)),
            esc(serializarLinks(aula.links))
          ].join(','));
        });
      }
    });
  });

  const csv = linhas.join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `videoaulas-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ============================================================
// UTIL
// ============================================================
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatarData(date) {
  const agora = new Date();
  const diffMs = agora - date;
  const diffMin = Math.floor(diffMs / 60000);
  const diffH = Math.floor(diffMin / 60);
  const diffD = Math.floor(diffH / 24);
  if (diffMin < 1) return 'agora';
  if (diffMin < 60) return `${diffMin}min atrás`;
  if (diffH < 24) return `${diffH}h atrás`;
  if (diffD < 7) return `${diffD}d atrás`;
  return date.toLocaleDateString('pt-BR');
}

// ============================================================
// INIT
// ============================================================
async function init() {
  let temaSalvo = 'claro';
  try { temaSalvo = localStorage.getItem(TEMA_KEY) || 'claro'; } catch (e) {}
  aplicarTema(temaSalvo);

  const btn = document.getElementById('btn-tema');
  if (btn) btn.addEventListener('click', alternarTema);

  const loading = document.createElement('div');
  loading.id = 'loading-inicial';
  loading.innerHTML = '<div class="spinner"></div><p>Carregando dados...</p>';
  document.body.appendChild(loading);

  try { await carregarDados(); } catch (e) { console.error(e); }

  render();
  loading.remove();

  let abaInicial = 'disciplinas';
  try { abaInicial = sessionStorage.getItem('abaAtiva') || 'disciplinas'; } catch (e) {}
  trocarTela(abaInicial);

  renderStorageInfo();

  console.log('============================');
  console.log('🔍 DIAGNÓSTICO DO AMBIENTE');
  console.log('============================');
  console.log('Contexto seguro?', window.isSecureContext);
  console.log('API File System?', typeof window.showSaveFilePicker);
  console.log('Origem:', window.location.origin);
  console.log('URL:', window.location.href);
  console.log('============================');
}

init();