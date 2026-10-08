import { LIGAS, TEAM_STRENGTH_DB, HOME_ADVANTAGE, DEFAULT_HOME_ADV } from './leagues.js';

// ---------- Lógica pura (testeable sin DOM) ----------

// A los `halflife` días, un partido pesa la mitad que uno de hoy.
export function pesoPorAntiguedad(fechaStr, halflifeDias, ahoraMs = Date.now()) {
  if (!fechaStr) return 0.3; // sin fecha: peso bajo, no se descarta
  const dias = (ahoraMs - new Date(fechaStr).getTime()) / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(dias) || dias < 0) return 0.3;
  return Math.pow(0.5, dias / halflifeDias);
}

// Recalcula atk/def por equipo a partir de un historial de partidos jugados.
// v2: modelo multiplicativo AJUSTADO POR RIVAL (un 2-0 a un equipo flojo vale
// menos que a uno fuerte), con ventaja local y encogimiento hacia 1.0 según
// cuántos partidos hay (priorJuegos = partidos "virtuales" a rating promedio).
// Pondera por antigüedad. Devuelve solo los equipos con partidos >= minMatches.
export function recalcularRatings(partidos, {
  halflifeDias = 60, minMatches = 3, ahoraMs = Date.now(),
  homeAdv = 1.2, priorJuegos = 4, iteraciones = 30,
} = {}) {
  const validos = [];
  const conteo = {};
  let sumaPesoGoles = 0, sumaPeso = 0;

  for (const p of partidos) {
    if (p.goles_local == null || p.goles_visitante == null || !p.local || !p.visitante) continue;
    const w = pesoPorAntiguedad(p.fecha, halflifeDias, ahoraMs);
    validos.push({ h: p.local, a: p.visitante, gl: p.goles_local, gv: p.goles_visitante, w });
    conteo[p.local] = (conteo[p.local] || 0) + 1;
    conteo[p.visitante] = (conteo[p.visitante] || 0) + 1;
    sumaPesoGoles += w * (p.goles_local + p.goles_visitante);
    sumaPeso += w * 2; // cada partido aporta 2 lados (local + visitante)
  }

  const ligaAvgPorLado = sumaPeso > 0 ? sumaPesoGoles / sumaPeso : null;
  if (!ligaAvgPorLado) return { ligaAvgPorLado: null, equipos: [] };

  const nombres = Object.keys(conteo);
  const atk = {}, def = {};
  for (const n of nombres) { atk[n] = 1; def[n] = 1; }
  const sq = Math.sqrt(homeAdv);
  const avg = ligaAvgPorLado;

  for (let it = 0; it < iteraciones; it++) {
    const numA = {}, denA = {}, numD = {}, denD = {};
    for (const n of nombres) { numA[n] = priorJuegos * avg; denA[n] = priorJuegos * avg; numD[n] = priorJuegos * avg; denD[n] = priorJuegos * avg; }
    for (const m of validos) {
      // goles del local = avg * atk_local * def_visita * sq ; goles del visitante = avg * atk_visita * def_local / sq
      numA[m.h] += m.w * m.gl;  denA[m.h] += m.w * avg * def[m.a] * sq;
      numA[m.a] += m.w * m.gv;  denA[m.a] += m.w * avg * def[m.h] / sq;
      numD[m.h] += m.w * m.gv;  denD[m.h] += m.w * avg * atk[m.a] / sq;
      numD[m.a] += m.w * m.gl;  denD[m.a] += m.w * avg * atk[m.h] * sq;
    }
    let sA = 0, sD = 0;
    for (const n of nombres) { atk[n] = numA[n] / denA[n]; def[n] = numD[n] / denD[n]; sA += atk[n]; sD += def[n]; }
    const mA = sA / nombres.length, mD = sD / nombres.length; // se mantiene media 1.0
    for (const n of nombres) { atk[n] /= mA; def[n] /= mD; }
  }

  const equipos = [];
  for (const n of nombres) {
    if (conteo[n] < minMatches) continue;
    equipos.push({ team: n, atk: +atk[n].toFixed(3), def: +def[n].toFixed(3), partidos: conteo[n] });
  }
  equipos.sort((a, b) => a.team.localeCompare(b.team));

  return { ligaAvgPorLado, equipos };
}

// ---------- Interfaz (solo corre en el navegador) ----------

if (typeof document !== 'undefined') {
  const fileInput = document.getElementById('historial-file');
  const fileInfo = document.getElementById('file-info');
  const halflifeInput = document.getElementById('halflife');
  const minMatchesInput = document.getElementById('minmatches');
  const runBtn = document.getElementById('run-btn');
  const resultsSection = document.getElementById('results');
  const resultsContent = document.getElementById('results-content');

  let historial = null;

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    runBtn.disabled = true;
    historial = null;
    if (!file) { fileInfo.textContent = ''; return; }
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.leagueKey || !LIGAS[data.leagueKey]) {
        fileInfo.textContent = '❌ El archivo no tiene una liga reconocida (leagueKey).';
        return;
      }
      if (!Array.isArray(data.partidos) || data.partidos.length === 0) {
        fileInfo.textContent = '❌ El archivo no tiene partidos.';
        return;
      }
      historial = data;
      fileInfo.textContent = `✅ ${data.liga || data.leagueKey} — ${data.partidos.length} partidos cargados.`;
      runBtn.disabled = false;
    } catch (err) {
      fileInfo.textContent = '❌ No se pudo leer el archivo: ' + err.message;
    }
  });

  runBtn.addEventListener('click', () => {
    if (!historial) return;
    const halflifeDias = Math.max(1, +halflifeInput.value || 60);
    const minMatches = Math.max(1, +minMatchesInput.value || 3);

    const homeAdv = HOME_ADVANTAGE[historial.leagueKey] ?? DEFAULT_HOME_ADV;
    const { ligaAvgPorLado, equipos } = recalcularRatings(historial.partidos, { halflifeDias, minMatches, homeAdv });

    if (!ligaAvgPorLado || equipos.length === 0) {
      resultsContent.innerHTML = `<div class="card"><h3>Sin datos suficientes</h3><p style="color:var(--chalk-dim)">Bajá el mínimo de partidos o cargá un historial más grande.</p></div>`;
      resultsSection.style.display = 'block';
      return;
    }

    renderResultados(equipos, historial.leagueKey);
  });

  function renderResultados(equipos, leagueKey) {
    const viejo = TEAM_STRENGTH_DB[leagueKey] || {};

    const filasHtml = equipos.map(f => {
      const v = viejo[f.team];
      const flechaAtk = v ? (f.atk >= v.atk ? '↑' : '↓') : '';
      const flechaDef = v ? (f.def >= v.def ? '↑' : '↓') : '';
      return `
        <div class="compare-row">
          <span>${f.team}</span>
          <span class="grid-plain">${f.atk} ${flechaAtk}</span>
          <span class="grid-plain">${f.def} ${flechaDef}</span>
          <span class="grid-plain">${f.partidos}p</span>
        </div>`;
    }).join('');

    const nuevoObj = {};
    for (const f of equipos) nuevoObj[f.team] = { atk: f.atk, def: f.def };
    const snippet = JSON.stringify(nuevoObj, null, 2);

    resultsContent.innerHTML = `
      <div class="card">
        <h3>${equipos.length} equipos recalculados</h3>
        <div class="compare-row compare-head"><span></span><span>Ataque</span><span>Defensa</span><span>Muestras</span></div>
        ${filasHtml}
      </div>
      <div class="card">
        <h3>Para pegar en leagues.js</h3>
        <p style="color:var(--chalk-dim); font-size:0.85rem; margin-top:0;">
          Reemplazá a mano los valores de estos equipos dentro de <code>TEAM_STRENGTH_DB["${leagueKey}"]</code>.
          Esto no te toca el archivo solo — vos decidís qué pegar.
        </p>
        <textarea readonly style="width:100%; min-height:220px; background:var(--surface-2); color:var(--chalk); border:1px solid var(--line); border-radius:8px; padding:10px; font-family:'IBM Plex Mono',monospace; font-size:0.78rem;">${snippet}</textarea>
      </div>
    `;
    resultsSection.style.display = 'block';
  }
}
