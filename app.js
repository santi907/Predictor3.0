// app.js
import { LIGAS } from './leagues.js';
import { simulateMatch, getTeamsForLeague } from './model.js';
import { AutoCalibrate } from './auto-calibrate.js';

const ESTADO_KEY = 'vv_estado_seleccion';
let ligaKeyGlobal = 'CPA';

function guardarEstado(leagueKey, homeTeam, awayTeam) {
  try {
    localStorage.setItem(ESTADO_KEY, JSON.stringify({ liga: leagueKey, local: homeTeam, visitante: awayTeam }));
  } catch (e) {}
}

function leerEstado() {
  try {
    const raw = localStorage.getItem(ESTADO_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

const UMBRAL_1X2 = 45;
const UMBRAL_GOLES = 60;
const UMBRAL_BTTS = 60;
const UMBRAL_CORNERS = 60;

function getBettingConfig(ligaKey) {
  const liga = LIGAS[ligaKey];
  return liga?.betting || { status: 'unknown' };
}

function esMercadoValido(ligaKey, mercado) {
  const config = getBettingConfig(ligaKey);
  if (config.status !== 'green' && config.status !== 'yellow') return false;
  if (!config.mercados) return false;
  return config.mercados.some(m => mercado.includes(m));
}

document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('api-key');
  const saveApiKeyBtn = document.getElementById('save-api-key');
  const apiStatus = document.getElementById('api-status');
  const leagueSelect = document.getElementById('league-select');
  const homeSelect = document.getElementById('home-team-select');
  const awaySelect = document.getElementById('away-team-select');
  const simulateBtn = document.getElementById('simulate-btn');
  const resultsDiv = document.getElementById('results');
  const predictionsContent = document.getElementById('predictions-content');

  function updateTokenStatus() {
    const token = localStorage.getItem('bzzoiro_token');
    if (token) {
      apiKeyInput.value = token;
      apiStatus.textContent = '✅ Token guardado';
      apiStatus.style.color = 'var(--green)';
    } else {
      apiStatus.textContent = '⚠️ No hay token';
      apiStatus.style.color = 'var(--yellow)';
    }
  }

  saveApiKeyBtn.addEventListener('click', () => {
    const token = apiKeyInput.value.trim();
    if (token) {
      localStorage.setItem('bzzoiro_token', token);
      updateTokenStatus();
    } else {
      apiStatus.textContent = '❌ Ingresa un token válido';
      apiStatus.style.color = 'var(--red)';
    }
  });

  updateTokenStatus();

  async function mostrarParamsActivos(ligaKey) {
    const params = await AutoCalibrate.getParamsActivos(ligaKey);
    const el = document.getElementById('params-status');
    if (!el) return;

    if (!params) {
      el.innerHTML = '⚠️ Sin calibración guardada (corre backtest primero)';
      el.style.color = 'var(--yellow)';
      return;
    }

    const fuente = params.fuente === 'repo' ? ' (del repo)' : ' (local)';
    const config = getBettingConfig(ligaKey);

    let html = `<div style="font-family:'IBM Plex Mono',monospace; font-size:0.78rem; line-height:1.5;">`;
    html += `<div>📊 HA=${params.homeAdvantage.toFixed(3)} rho=${params.rho.toFixed(3)}${fuente}</div>`;

    if (config.status === 'green') {
      el.style.color = 'var(--green)';
      html += `<div style="color:var(--green); font-weight:600; margin-top:4px;">✅ LIGA APTA PARA APOSTAR</div>`;
      if (config.mercados) html += `<div style="font-size:0.72rem; margin-top:2px;">Mercados: ${config.mercados.join(' · ')}</div>`;
      html += `<div style="font-size:0.72rem;">Stake sugerido: 1% de la banca</div>`;
      if (config.nota) html += `<div style="font-size:0.7rem; color:var(--chalk-dim); margin-top:2px;">${config.nota}</div>`;
    } else if (config.status === 'yellow') {
      el.style.color = 'var(--yellow)';
      html += `<div style="color:var(--yellow); font-weight:600; margin-top:4px;">⚠️ LIGA PROMETEDORA (stake bajo)</div>`;
      if (config.mercados) html += `<div style="font-size:0.72rem; margin-top:2px;">Mercados: ${config.mercados.join(' · ')}</div>`;
      html += `<div style="font-size:0.72rem;">Stake sugerido: 0.5% de la banca</div>`;
      if (config.nota) html += `<div style="font-size:0.7rem; color:var(--chalk-dim); margin-top:2px;">${config.nota}</div>`;
    } else if (config.status === 'red') {
      el.style.color = 'var(--red)';
      html += `<div style="color:var(--red); font-weight:600; margin-top:4px;">❌ NO APOSTAR EN ESTA LIGA</div>`;
      html += `<div style="font-size:0.72rem;">Esta liga pierde contra cuota. Solo para análisis.</div>`;
    } else {
      el.style.color = 'var(--chalk-dim)';
      html += `<div style="font-size:0.72rem;">Liga sin clasificar.</div>`;
    }

    html += `</div>`;
    el.innerHTML = html;
  }

  function populateLeagues() {
    for (const [key, liga] of Object.entries(LIGAS)) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = liga.name;
      leagueSelect.appendChild(option);
    }
  }

  function populateTeams(leagueKey, { keepSelection = false } = {}) {
    const prevHome = keepSelection ? homeSelect.value : null;
    const prevAway = keepSelection ? awaySelect.value : null;
    homeSelect.innerHTML = '';
    awaySelect.innerHTML = '';
    const teams = getTeamsForLeague(leagueKey);
    const teamNames = Object.keys(teams);
    if (teamNames.length === 0) return;
    for (const name of teamNames) {
      homeSelect.appendChild(new Option(name, name));
      awaySelect.appendChild(new Option(name, name));
    }
    let homeIndex = 0;
    let awayIndex = Math.min(1, teamNames.length - 1);
    if (prevHome && teamNames.includes(prevHome)) homeIndex = teamNames.indexOf(prevHome);
    if (prevAway && teamNames.includes(prevAway) && prevAway !== teamNames[homeIndex]) {
      awayIndex = teamNames.indexOf(prevAway);
    } else if (teamNames[homeIndex] === teamNames[awayIndex]) {
      awayIndex = (homeIndex + 1) % teamNames.length;
    }
    homeSelect.selectedIndex = homeIndex;
    awaySelect.selectedIndex = awayIndex;
  }

  async function restaurarEstado() {
    const estado = leerEstado();
    if (estado?.liga && LIGAS[estado.liga]) {
      leagueSelect.value = estado.liga;
      populateTeams(estado.liga);
      const teamNames = Object.keys(getTeamsForLeague(estado.liga));
      if (estado.local && teamNames.includes(estado.local)) homeSelect.value = estado.local;
      if (estado.visitante && teamNames.includes(estado.visitante) && estado.visitante !== homeSelect.value) {
        awaySelect.value = estado.visitante;
      }
    } else {
      const firstLeague = Object.keys(LIGAS)[0];
      if (firstLeague) {
        leagueSelect.value = firstLeague;
        populateTeams(firstLeague);
      }
    }
    ligaKeyGlobal = leagueSelect.value;
    await mostrarParamsActivos(leagueSelect.value);
  }

  leagueSelect.addEventListener('change', async (e) => {
    populateTeams(e.target.value);
    guardarEstado(e.target.value, homeSelect.value, awaySelect.value);
    ligaKeyGlobal = e.target.value;
    await mostrarParamsActivos(e.target.value);
  });

  homeSelect.addEventListener('change', () => {
    guardarEstado(leagueSelect.value, homeSelect.value, awaySelect.value);
  });

  awaySelect.addEventListener('change', () => {
    guardarEstado(leagueSelect.value, homeSelect.value, awaySelect.value);
  });

  simulateBtn.addEventListener('click', async () => {
    const leagueKey = leagueSelect.value;
    const homeTeam = homeSelect.value;
    const awayTeam = awaySelect.value;
    if (!leagueKey || !homeTeam || !awayTeam || homeTeam === awayTeam) {
      alert('Selecciona liga y dos equipos distintos');
      return;
    }
    guardarEstado(leagueKey, homeTeam, awayTeam);
    simulateBtn.disabled = true;
    simulateBtn.textContent = 'Calculando...';
    try {
      const paramsGuardados = await AutoCalibrate.getParamsActivos(leagueKey);
      const results = await simulateMatch(leagueKey, homeTeam, awayTeam, {
        calibracion: paramsGuardados || undefined,
      });
      displayResults(results, leagueKey);
    } catch (err) {
      alert('Error: ' + err.message);
      console.error('❌ Error en simulación', err);
    } finally {
      simulateBtn.disabled = false;
      simulateBtn.textContent = 'Simular partido';
    }
  });

  function fmt(n) { return Number(n).toFixed(1); }

  function fila(label, prob) {
    const color = getColor(prob);
    const pct = Math.max(0, Math.min(100, prob));
    return `<div class="prob-row"><div class="prob-row-top"><span>${label}</span><span class="prob" style="color:${color}">${fmt(prob)}%</span></div><div class="semaforo-track"><div class="semaforo-fill" style="width:${pct}%;background:${color}"></div></div></div>`;
  }

  function gridProb(val) {
    const color = getColor(val);
    const pct = Math.max(0, Math.min(100, val));
    return `<span class="grid-prob"><span class="grid-prob-value" style="color:${color}">${fmt(val)}%</span><span class="grid-prob-bar"><span style="width:${pct}%;background:${color}"></span></span></span>`;
  }

  function getColor(prob) {
    if (prob >= 65) return 'var(--green)';
    if (prob >= 42) return 'var(--yellow)';
    return 'var(--red)';
  }

  function generarPicks(data, ligaKey) {
    const picks = [];
    const config = getBettingConfig(ligaKey);
    if (config.status === 'red') return [];

    const rp = data.resultProbs;
    const max1x2 = Math.max(rp.local, rp.empate, rp.visitante);

    if (max1x2 >= UMBRAL_1X2 && esMercadoValido(ligaKey, '1X2')) {
      if (rp.local === max1x2) picks.push({ label: 'Local gana', prob: rp.local });
      else if (rp.empate === max1x2) picks.push({ label: 'Empate', prob: rp.empate });
      else picks.push({ label: 'Visitante gana', prob: rp.visitante });
    }

    const lineasGoles = [
      { label: 'Over 3.5 goles', prob: data.over35, mercado: 'Over 3.5' },
      { label: 'Over 2.5 goles', prob: data.over25, mercado: 'Over 2.5' },
      { label: 'Over 1.5 goles', prob: data.over15, mercado: 'Over 1.5' },
    ];
    for (const l of lineasGoles) {
      if (l.prob != null && l.prob >= UMBRAL_GOLES && esMercadoValido(ligaKey, l.mercado)) {
        picks.push({ label: l.label, prob: l.prob });
        break;
      }
    }

    if (data.btts != null && data.btts >= UMBRAL_BTTS && esMercadoValido(ligaKey, 'BTTS')) {
      picks.push({ label: 'Ambos marcan (Sí)', prob: data.btts });
    }

    if (data.cornerProbs) {
      const lineasCorners = [
        { label: 'Over 9.5 córners', prob: data.cornerProbs.over9 },
        { label: 'Over 8.5 córners', prob: data.cornerProbs.over8 },
        { label: 'Over 7.5 córners', prob: data.cornerProbs.over7 },
      ];
      for (const l of lineasCorners) {
        if (l.prob != null && l.prob >= UMBRAL_CORNERS) {
          picks.push({ label: l.label, prob: l.prob });
          break;
        }
      }
    }

    if (data.cornerProbs?.porEquipo) {
      const cL = data.cornerProbs.porEquipo.local?.over3;
      const cV = data.cornerProbs.porEquipo.visitante?.over3;
      if (cL != null && cL >= UMBRAL_CORNERS) picks.push({ label: `Córners ${data.homeTeam} Over 3.5`, prob: cL });
      if (cV != null && cV >= UMBRAL_CORNERS) picks.push({ label: `Córners ${data.awayTeam} Over 3.5`, prob: cV });
    }

    return picks;
  }

  function renderPicksCard(data, ligaKey) {
    const picks = generarPicks(data, ligaKey);
    const config = getBettingConfig(ligaKey);
    const umbrales = `Umbrales: 1X2 ≥${UMBRAL_1X2}% · Goles ≥${UMBRAL_GOLES}% · BTTS ≥${UMBRAL_BTTS}% · Córners ≥${UMBRAL_CORNERS}%`;

    if (config.status === 'red') {
      return `<div class="card" style="border:2px solid var(--red);"><h3 style="color:var(--red);">❌ NO APOSTAR EN ESTA LIGA</h3><p style="color:var(--chalk-dim); margin:8px 0 0; font-size:0.9rem;">Esta liga pierde contra cuota. Usala solo para análisis.</p></div>`;
    }

    if (picks.length === 0) {
      return `<div class="card" style="border:2px solid var(--line); opacity:0.8;"><h3>🎯 Mejores picks para este partido</h3><p style="color:var(--chalk-dim); margin:8px 0 0; font-size:0.9rem;">Sin picks. Ningún mercado con edge supera los umbrales.</p><p style="color:var(--chalk-dim); margin:6px 0 0; font-size:0.72rem;">${umbrales}</p></div>`;
    }

    const filas = picks.map(p => `<div class="prob-row"><div class="prob-row-top"><span>✅ ${p.label}</span><span class="prob" style="color:${getColor(p.prob)}">${fmt(p.prob)}%</span></div><div class="semaforo-track"><div class="semaforo-fill" style="width:${p.prob}%;background:${getColor(p.prob)}"></div></div></div>`).join('');

    return `<div class="card" style="border:2px solid var(--green);"><h3>🎯 Mejores picks <small>(${picks.length})</small></h3>${filas}<p style="color:var(--chalk-dim); margin:10px 0 0; font-size:0.72rem;">${umbrales}</p></div>`;
  }

  function displayResults(data, ligaKey) {
    const compareRow = (label, own, ml, blended) => `<div class="compare-row"><span>${label}</span>${gridProb(own)}${gridProb(ml)}${gridProb(blended)}</div>`;

    const comparisonCard = data.bzzoiroML ? `<div class="card"><h3>Tu modelo vs. Bzzoiro ML${data.bzzoiroML.confidence != null ? ` <small>(confianza ${(data.bzzoiroML.confidence * 100).toFixed(0)}%)</small>` : ''}</h3>${data.blended ? `<div class="compare-row compare-head"><span></span><span>Poisson</span><span>Bzzoiro ML</span><span>Promedio</span></div>${compareRow('Local', data.resultProbs.local, data.bzzoiroML.resultProbs.local, data.blended.resultProbs.local)}${compareRow('Empate', data.resultProbs.empate, data.bzzoiroML.resultProbs.empate, data.blended.resultProbs.empate)}${compareRow('Visitante', data.resultProbs.visitante, data.bzzoiroML.resultProbs.visitante, data.blended.resultProbs.visitante)}${compareRow('Over 1.5', data.over15, data.bzzoiroML.over15, data.blended.over15)}${compareRow('Over 2.5', data.over25, data.bzzoiroML.over25, data.blended.over25)}${compareRow('BTTS', data.btts, data.bzzoiroML.btts, data.blended.btts)}` : `<div class="compare-row"><span>Datos ML parciales.</span></div>`}</div>` : '';

    const picksCard = renderPicksCard(data, ligaKey);

    predictionsContent.innerHTML = `
      ${picksCard}
      <div class="card"><h3>Resultado 1X2</h3>${fila('Local', data.resultProbs.local)}${fila('Empate', data.resultProbs.empate)}${fila('Visitante', data.resultProbs.visitante)}</div>
      <div class="card"><h3>Goles</h3>${fila('Over 1.5', data.over15)}${fila('Over 2.5', data.over25)}${fila('Over 3.5', data.over35)}</div>
      <div class="card"><h3>Ambos marcan (BTTS)</h3>${fila('Sí', data.btts)}</div>
      ${data.cornerProbs ? `<div class="card"><h3>Córneres</h3>${fila('Over 7.5', data.cornerProbs.over7)}${fila('Over 8.5', data.cornerProbs.over8)}${fila('Over 9.5', data.cornerProbs.over9)}</div>` : ''}
      ${comparisonCard}
    `;
    resultsDiv.style.display = 'block';
  }

  populateLeagues();
  restaurarEstado();
});
