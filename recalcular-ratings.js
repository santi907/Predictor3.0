import { LIGAS, TEAM_STRENGTH_DB } from './leagues.js';

// ---------- Lógica pura (testeable sin DOM) ----------

// A los `halflife` días, un partido pesa la mitad que uno de hoy.
export function pesoPorAntiguedad(fechaStr, halflifeDias, ahoraMs = Date.now()) {
  if (!fechaStr) return 0.3; // sin fecha: peso bajo, no se descarta
  const dias = (ahoraMs - new Date(fechaStr).getTime()) / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(dias) || dias < 0) return 0.3;
  return Math.pow(0.5, dias / halflifeDias);
}

// Recalcula atk/def por equipo a partir de un historial de partidos jugados,
// ponderando por antigüedad. Devuelve solo los equipos con partidos >= minMatches.
export function recalcularRatings(partidos, { halflifeDias = 60, minMatches = 3, ahoraMs = Date.now() } = {}) {
  const porEquipo = {};
  let sumaPesoGoles = 0, sumaPeso = 0;

  for (const p of partidos) {
    if (p.goles_local == null || p.goles_visitante == null || !p.local || !p.visitante) continue;
    const w = pesoPorAntiguedad(p.fecha, halflifeDias, ahoraMs);

    for (const [team, gf, ga] of [
      [p.local, p.goles_local, p.goles_visitante],
      [p.visitante, p.goles_visitante, p.goles_local],
    ]) {
      if (!porEquipo[team]) porEquipo[team] = { sumaPesoGF: 0, sumaPesoGA: 0, sumaPeso: 0, partidos: 0 };
      porEquipo[team].sumaPesoGF += w * gf;
      porEquipo[team].sumaPesoGA += w * ga;
      porEquipo[team].sumaPeso += w;
      porEquipo[team].partidos += 1;
    }

    sumaPesoGoles += w * (p.goles_local + p.goles_visitante);
    sumaPeso += w * 2; // cada partido aporta 2 lados (local + visitante)
  }

  const ligaAvgPorLado = sumaPeso > 0 ? sumaPesoGoles / sumaPeso : null;
  if (!ligaAvgPorLado) return { ligaAvgPorLado: null, equipos: [] };

  const equipos = [];
  for (const [team, d] of Object.entries(porEquipo)) {
    if (d.partidos < minMatches) continue;
    const atk = +((d.sumaPesoGF / d.sumaPeso) / ligaAvgPorLado).toFixed(3);
    const def = +((d.sumaPesoGA / d.sumaPeso) / ligaAvgPorLado).toFixed(3);
    equipos.push({ team, atk, def, partidos: d.partidos });
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

    const { ligaAvgPorLado, equipos } = recalcularRatings(historial.partidos, { halflifeDias, minMatches });

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
