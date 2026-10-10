// backtest.js
// MEJORAS:
// - Una sola calibración (la que guarda params es la que usa el backtest).
// - calcularRecomendacion respeta betting.status y betting.mercados.
// - try/catch en renderPicks y renderResults.
// - Todas las secciones visibles al final.

import { LIGAS, HOME_ADVANTAGE, DIXON_COLES_RHO, FILTRO_EV, SHRINK_ALPHA, getUmbrales } from './leagues.js';
import { simulateMatch } from './model.js';
import { calcularTasasBase, shrinkHaciaBase } from './calibrate.js';
import { AutoCalibrate } from './auto-calibrate.js';

const CAL_MIN_PARTIDOS = 20;

function devigar2(oddsA, oddsB) {
  if (!oddsA || !oddsB) return null;
  const pA = 1 / oddsA, pB = 1 / oddsB;
  return (pA / (pA + pB)) * 100;
}
function devigar3(oddsA, oddsB, oddsC) {
  if (!oddsA || !oddsB || !oddsC) return null;
  const pA = 1 / oddsA, pB = 1 / oddsB, pC = 1 / oddsC;
  const s = pA + pB + pC;
  return [(pA / s) * 100, (pB / s) * 100, (pC / s) * 100];
}
function pasaEV(probPct, cuota) {
  if (!cuota || !probPct) return false;
  return (probPct / 100) * cuota > FILTRO_EV;
}

const fileInput = document.getElementById('historial-file');
const fileInfo = document.getElementById('file-info');
const runBtn = document.getElementById('run-btn');
const logSection = document.getElementById('log-section');
const logDiv = document.getElementById('log');
const calibrationSection = document.getElementById('calibration-section');
const calibrationContent = document.getElementById('calibration-content');
const picksSection = document.getElementById('picks-section');
const picksContent = document.getElementById('picks-content');
const resultsSection = document.getElementById('results');
const resultsContent = document.getElementById('results-content');
const exportSection = document.getElementById('export-section');
const exportBtn = document.getElementById('export-btn');

let historial = null;
let filasComparacion = [];

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

function fmt(n) { return Number(n).toFixed(1); }
function log(msg) {
  logSection.style.display = 'block';
  logDiv.textContent += msg + '\n';
  logDiv.scrollTop = logDiv.scrollHeight;
}

class MarketStats {
  constructor(name) {
    this.name = name;
    this.n = 0; this.hits = 0; this.brierSum = 0; this.sumaReal = 0;
    this.buckets = { '0-20': [0, 0], '20-40': [0, 0], '40-60': [0, 0], '60-80': [0, 0], '80-100': [0, 0] };
  }
  add(predictedPct, actualBool) {
    if (predictedPct == null || !Number.isFinite(predictedPct)) return;
    this.n++;
    this.sumaReal += actualBool ? 1 : 0;
    if ((predictedPct >= 50) === actualBool) this.hits++;
    const p = predictedPct / 100;
    this.brierSum += (p - (actualBool ? 1 : 0)) ** 2;
    const b = predictedPct < 20 ? '0-20' : predictedPct < 40 ? '20-40' : predictedPct < 60 ? '40-60' : predictedPct < 80 ? '60-80' : '80-100';
    this.buckets[b][0] += actualBool ? 1 : 0;
    this.buckets[b][1] += 1;
  }
  summary() {
    const hitRate = this.n ? (this.hits / this.n * 100) : null;
    const brier = this.n ? (this.brierSum / this.n) : null;
    const baseRate = this.n ? (this.sumaReal / this.n) : null;
    const brierBase = baseRate != null ? baseRate * (1 - baseRate) : null;
    const mejoraVsBase = (brier != null && brierBase != null && brierBase > 0.0001)
      ? ((brierBase - brier) / brierBase * 100) : null;
    return { name: this.name, n: this.n, hitRate, brier, baseRate, brierBase, mejoraVsBase, buckets: this.buckets };
  }
}

async function calibrarLiga(leagueKey, partidos) {
  partidos = [...partidos].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  const tasasFull = calcularTasasBase(partidos);
  if (tasasFull.n < CAL_MIN_PARTIDOS) {
    log(`⚠️ Solo ${tasasFull.n} partidos — se omite la calibración.`);
    return { calibracion: null, tasas: tasasFull, historial: [], leagueKey };
  }
  log(`\n🎯 Calibrando ${leagueKey} por máxima verosimilitud (ventana de ${AutoCalibrate.CONFIG.VENTANA} partidos)...`);
  const auto = await AutoCalibrate.ejecutar(leagueKey, partidos, { force: true, onLog: log });
  if (!auto.calibracion) {
    log(`⚠️ ${auto.razon || 'No se pudo calibrar'} — se omite la calibración.`);
    return { calibracion: null, tasas: auto.tasas || tasasFull, historial: auto.historial || [], leagueKey, diagnostico: auto.diagnostico };
  }
  log(`   ℹ️ Las métricas de abajo se miden sobre los mismos partidos usados para ajustar (in-sample); el hold-out de arriba es la señal fuera de muestra.`);
  return { calibracion: auto.calibracion, tasas: auto.tasas || tasasFull, historial: auto.historial || [], leagueKey, diagnostico: auto.diagnostico };
}

function renderCalibracion(resultado) {
  if (!resultado) return;
  const { calibracion, tasas, historial, leagueKey } = resultado;
  calibrationSection.style.display = 'block';
  if (!calibracion) {
    calibrationContent.innerHTML = `<p style="color:var(--chalk-dim)">Liga con ${tasas?.n ?? 0} partidos — no se calibró (mínimo ${CAL_MIN_PARTIDOS}).</p>`;
    return;
  }
  const ultimo = historial?.[historial.length - 1];
  if (!ultimo) return;
  const fila = (label, real, pred) => {
    const d = Math.abs(real - pred);
    const color = d < 0.03 ? 'var(--green)' : d < 0.06 ? 'var(--yellow)' : 'var(--red)';
    return `<div class="compare-row"><span>${label}</span><span class="grid-plain">real ${fmt(real*100)}%</span><span class="grid-plain" style="color:${color}">pred ${fmt(pred*100)}%</span></div>`;
  };
  const originalHA = HOME_ADVANTAGE[leagueKey];
  const hold = resultado.diagnostico?.holdout;
  const originalRho = DIXON_COLES_RHO[leagueKey];
  const umbrales = getUmbrales(leagueKey);
  calibrationContent.innerHTML = `
    <div class="card">
      <h3>Parámetros derivados <small>(auto)</small></h3>
      <div class="compare-row"><span>HOME_ADVANTAGE</span><span class="grid-plain">${(originalHA ?? 1.25).toFixed(3)} original</span><span class="prob" style="color:var(--green)">${calibracion.homeAdvantage.toFixed(3)}</span></div>
      <div class="compare-row"><span>DIXON_COLES_RHO</span><span class="grid-plain">${(originalRho ?? -0.1).toFixed(3)} original</span><span class="prob" style="color:${calibracion.rho <= -0.19 ? 'var(--yellow)' : 'var(--green)'}">${calibracion.rho.toFixed(3)}</span></div>
      <h3 class="corner-team-title">Distribución: real vs predicha (calibrada)</h3>
      <div class="compare-row compare-head"><span>Resultado</span><span>Real</span><span>Modelo</span></div>
      ${fila('Local gana', tasas.homeRate, ultimo.predHome)}
      ${fila('Empate', tasas.drawRate, ultimo.predDraw)}
      ${fila('Visitante gana', tasas.awayRate, ultimo.predAway)}
      <h3 class="corner-team-title">Umbrales activos para ${leagueKey}</h3>
      <div class="compare-row"><span>1X2 favorito mínimo</span><span class="grid-plain"></span><span class="prob" style="color:var(--green)">${umbrales.umbral1x2}%</span></div>
      <div class="compare-row"><span>Goles (Over X.5)</span><span class="grid-plain"></span><span class="prob" style="color:var(--green)">${umbrales.umbralGoles}%</span></div>
      <div class="compare-row"><span>Córners totales</span><span class="grid-plain"></span><span class="prob" style="color:var(--green)">${umbrales.umbralCorners}%</span></div>
      <div class="compare-row"><span>BTTS</span><span class="grid-plain"></span><span class="prob" style="color:var(--green)">${umbrales.umbralBtss}%</span></div>
      <div class="compare-row"><span>Filtro EV mínimo</span><span class="grid-plain"></span><span class="prob" style="color:var(--green)">${FILTRO_EV}</span></div>
      <p style="margin:10px 0 0; font-size:0.8rem; color:var(--chalk-dim)">
        Error total L/E/V: ${fmt(ultimo.err * 100)}% · goles/partido usados: ${calibracion.goalsAvg?.toFixed(2) ?? '—'}.
        ${hold ? `Hold-out (${hold.nTest} partidos): ${hold.aceptado ? 'ajuste aceptado' : 'el ajuste no mejoraba → se mantuvo el valor base'} (dif ${hold.mejora} ± ${hold.se}).` : 'Muestra chica: sin hold-out.'}
        Shrinkage activo (α=${SHRINK_ALPHA}).
      </p>
    </div>`;
}

function calcularRecomendacion(p, pred, resultProbsFinal, leagueKey) {
  const U = getUmbrales(leagueKey);
  const betting = LIGAS[leagueKey]?.betting || {};
  const statusLiga = betting.status || 'unknown';
  const mercadosLiga = betting.mercados || [];

  const rec = {
    fecha: p.fecha ?? '', local: p.local, visitante: p.visitante,
    real: p.goles_local != null ? `${p.goles_local}-${p.goles_visitante}` : null,
    resultado: null, totalGoles: null,
    cornersLocal: p.corners_local ?? null, cornersVisit: p.corners_visitante ?? null,
    picks: [], sin1x2: null, sinEV: [],
  };

  // Si la liga está en rojo, NO se genera ningún pick.
  if (statusLiga === 'red') return rec;

  const permite = (mercado) => {
    if (statusLiga !== 'green' && statusLiga !== 'yellow') return false;
    if (mercadosLiga.length === 0) return false;
    return mercadosLiga.some(m => mercado.includes(m) || m.includes(mercado));
  };

  if (p.goles_local != null && p.goles_visitante != null) {
    rec.totalGoles = p.goles_local + p.goles_visitante;
    rec.resultado = p.goles_local > p.goles_visitante ? 'local'
                  : p.goles_local < p.goles_visitante ? 'visitante' : 'empate';
  }

  // 1X2
  const max1x2 = Math.max(resultProbsFinal.local, resultProbsFinal.empate, resultProbsFinal.visitante);
  if (max1x2 >= U.umbral1x2 && permite('1X2')) {
    let pick;
    if (resultProbsFinal.local === max1x2) pick = { code: '1', label: 'Local gana', prob: resultProbsFinal.local, casaOdds: p.odds_local, hit: rec.resultado === 'local' };
    else if (resultProbsFinal.empate === max1x2) pick = { code: 'X', label: 'Empate', prob: resultProbsFinal.empate, casaOdds: p.odds_empate, hit: rec.resultado === 'empate' };
    else pick = { code: '2', label: 'Visitante gana', prob: resultProbsFinal.visitante, casaOdds: p.odds_visitante, hit: rec.resultado === 'visitante' };
    if (pasaEV(pick.prob, pick.casaOdds)) {
      rec.picks.push({ mercado: '1X2', ...pick, tieneReal: rec.resultado != null });
    } else {
      rec.sinEV.push({ label: pick.label, prob: pick.prob, cuota: pick.casaOdds });
    }
  }

  // Goles
  const lineas = [
    { code: 'over35', label: 'Over 3.5 goles', prob: pred.over35, umbral: 3.5, casaOdds: p.odds_over35, mercado: 'Over 3.5' },
    { code: 'over25', label: 'Over 2.5 goles', prob: pred.over25, umbral: 2.5, casaOdds: p.odds_over25, mercado: 'Over 2.5' },
    { code: 'over15', label: 'Over 1.5 goles', prob: pred.over15, umbral: 1.5, casaOdds: p.odds_over15, mercado: 'Over 1.5' },
  ];
  for (const l of lineas) {
    if (l.prob != null && l.prob >= U.umbralGoles && permite(l.mercado)) {
      if (!pasaEV(l.prob, l.casaOdds)) {
        rec.sinEV.push({ label: l.label, prob: l.prob, cuota: l.casaOdds });
        break;
      }
      const hit = rec.totalGoles != null ? rec.totalGoles > l.umbral : null;
      rec.picks.push({ mercado: 'Goles', code: l.code, label: l.label, prob: l.prob, casaOdds: l.casaOdds, hit, tieneReal: rec.totalGoles != null });
      break;
    }
  }

  // BTTS
  if (pred.btts != null && pred.btts >= U.umbralBtss && permite('BTTS')) {
    if (pasaEV(pred.btts, p.odds_btts_si)) {
      const hit = (p.goles_local != null && p.goles_visitante != null) ? (p.goles_local > 0 && p.goles_visitante > 0) : null;
      rec.picks.push({ mercado: 'BTTS', code: 'btts_si', label: 'Ambos marcan (Sí)', prob: pred.btts, casaOdds: p.odds_btts_si, hit, tieneReal: hit != null });
    } else {
      rec.sinEV.push({ label: 'BTTS Sí', prob: pred.btts, cuota: p.odds_btts_si });
    }
  }

  // Córners totales (umbral 75 ahora)
  if (pred.cornerProbs) {
    const lineasC = [
      { code: 'c_over95', label: 'Over 9.5 córners', prob: pred.cornerProbs.over9, umbral: 9.5 },
      { code: 'c_over85', label: 'Over 8.5 córners', prob: pred.cornerProbs.over8, umbral: 8.5 },
      { code: 'c_over75', label: 'Over 7.5 córners', prob: pred.cornerProbs.over7, umbral: 7.5 },
    ];
    for (const l of lineasC) {
      if (l.prob != null && l.prob >= U.umbralCorners) {
        const hit = (p.corners_local != null && p.corners_visitante != null) ? (p.corners_local + p.corners_visitante > l.umbral) : null;
        rec.picks.push({ mercado: 'Córners totales', code: l.code, label: l.label, prob: l.prob, casaOdds: null, hit, tieneReal: hit != null, sinCuota: true });
        break;
      }
    }
  }

  return rec;
}

class PicksStats {
  constructor(umbrales) {
    this.umbrales = umbrales;
    this.mercados = {
      '1X2': { n: 0, nCuota: 0, hits: 0, profit: 0, label: `1X2 (favorito ≥ ${umbrales.umbral1x2}%)` },
      'Over 1.5': { n: 0, nCuota: 0, hits: 0, profit: 0, label: 'Over 1.5 goles' },
      'Over 2.5': { n: 0, nCuota: 0, hits: 0, profit: 0, label: 'Over 2.5 goles' },
      'Over 3.5': { n: 0, nCuota: 0, hits: 0, profit: 0, label: 'Over 3.5 goles' },
      'BTTS Sí': { n: 0, nCuota: 0, hits: 0, profit: 0, label: 'Ambos marcan (Sí)' },
      'Córners totales Over 7.5': { n: 0, nCuota: 0, hits: 0, profit: 0, label: 'Over 7.5 córners totales' },
      'Córners totales Over 8.5': { n: 0, nCuota: 0, hits: 0, profit: 0, label: 'Over 8.5 córners totales' },
      'Córners totales Over 9.5': { n: 0, nCuota: 0, hits: 0, profit: 0, label: 'Over 9.5 córners totales' },
    };
    this.partidosConPick = 0;
  }
  add(rec) {
    if (rec.picks.length > 0) this.partidosConPick++;
    for (const pick of rec.picks) {
      if (!pick.tieneReal) continue;
      let key;
      if (pick.mercado === '1X2') key = '1X2';
      else if (pick.mercado === 'Goles') {
        if (pick.code === 'over15') key = 'Over 1.5';
        else if (pick.code === 'over25') key = 'Over 2.5';
        else if (pick.code === 'over35') key = 'Over 3.5';
      } else if (pick.mercado === 'BTTS') key = 'BTTS Sí';
      else if (pick.mercado === 'Córners totales') {
        if (pick.code === 'c_over75') key = 'Córners totales Over 7.5';
        else if (pick.code === 'c_over85') key = 'Córners totales Over 8.5';
        else if (pick.code === 'c_over95') key = 'Córners totales Over 9.5';
      }
      if (!key || !this.mercados[key]) continue;
      this.mercados[key].n++;
      if (pick.casaOdds) this.mercados[key].nCuota++;
      if (pick.hit) {
        this.mercados[key].hits++;
        if (pick.casaOdds) this.mercados[key].profit += (pick.casaOdds - 1);
      } else {
        if (pick.casaOdds) this.mercados[key].profit -= 1;
      }
    }
  }
  summary() {
    const out = [];
    for (const [k, v] of Object.entries(this.mercados)) {
      out.push({ key: k, label: v.label, n: v.n, hits: v.hits, rate: v.n ? v.hits / v.n * 100 : null, profit: v.profit, nCuota: v.nCuota, roi: v.nCuota ? (v.profit / v.nCuota) * 100 : null });
    }
    return { mercados: out, partidosConPick: this.partidosConPick };
  }
}

function colorPick(v) { return v == null ? 'var(--chalk-dim)' : v >= 70 ? 'var(--green)' : v >= 60 ? 'var(--yellow)' : 'var(--red)'; }
function colorROI(roi) { return roi == null ? 'var(--chalk-dim)' : roi > 2 ? 'var(--green)' : roi >= -2 ? 'var(--yellow)' : 'var(--red)'; }
function valorEV(probPct, casaOdds) { if (!probPct || !casaOdds) return null; return (probPct / 100) * casaOdds; }

function renderPicks(recs, stats, leagueKey) {
  if (!recs || recs.length === 0) return;
  picksSection.style.display = 'block';
  const U = getUmbrales(leagueKey);
  const conPicks = recs.filter(r => r.picks.length > 0);
  const sinPicks = recs.filter(r => r.picks.length === 0);

  const resumen = stats.mercados.filter(m => m.n > 0).map(m => {
    const c = colorPick(m.rate), roiColor = colorROI(m.roi);
    const rateTxt = m.rate == null ? '—' : fmt(m.rate) + '%';
    const roiTxt = m.roi == null ? '—' : (m.roi >= 0 ? '+' : '') + fmt(m.roi) + '%';
    const profitTxt = m.profit == null || !Number.isFinite(m.profit) ? '—' : (m.profit >= 0 ? '+' : '') + m.profit.toFixed(2);
    return `<div class="compare-row"><span>${m.label}</span><span class="grid-plain">${m.n} pick${m.n === 1 ? '' : 's'}</span><span class="grid-plain" style="color:${c}">${rateTxt}</span><span class="grid-plain" style="color:${roiColor}">${roiTxt} (${profitTxt}u)</span></div>`;
  }).join('');

  const resumenHTML = `
    <div class="card" style="border:2px solid var(--green);">
      <h3>📊 Resumen de picks <small>(${stats.partidosConPick}/${recs.length} partidos con al menos un pick)</small></h3>
      <div class="compare-row compare-head"><span>Mercado</span><span>Picks</span><span>Acierto</span><span>ROI (profit)</span></div>
      ${resumen || '<div class="compare-row"><span>Sin picks con resultado real.</span></div>'}
      <p style="margin:10px 0 0; font-size:0.78rem; color:var(--chalk-dim); line-height:1.5;">
        <strong>Reglas para ${leagueKey}:</strong>
        1X2 ≥ ${U.umbral1x2}% · Goles ≥ ${U.umbralGoles}% · BTTS ≥ ${U.umbralBtss}% · Córners totales ≥ ${U.umbralCorners}% · Filtro EV ≥ ${FILTRO_EV}.
        <br><strong>Partidos sin picks:</strong> ${sinPicks.length}.
      </p>
    </div>`;

  const ordenados = [...conPicks].sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  const cards = ordenados.slice(0, 50).map(r => {
    const fechaCorta = r.fecha ? r.fecha.slice(0, 10) : '';
    const realTxt = r.real ? `Real: <strong>${r.real}</strong> (${r.resultado})` : 'Real: sin datos';
    const picksHTML = r.picks.map(pick => {
      const marca = pick.tieneReal ? (pick.hit ? '✅' : '❌') : '⏳';
      const realDetalle = pick.tieneReal
        ? (pick.mercado === 'Córners totales' ? `${(r.cornersLocal ?? 0) + (r.cornersVisit ?? 0)} córners` : `${r.totalGoles} goles`)
        : '';
      const ev = valorEV(pick.prob, pick.casaOdds);
      const valorBadge = ev != null ? (ev >= FILTRO_EV ? `<span style="color:var(--green); font-size:0.75rem;">· VALOR (EV ${ev.toFixed(2)})</span>` : `<span style="color:var(--chalk-dim); font-size:0.75rem;">· sin valor (EV ${ev.toFixed(2)})</span>`) : '';
      return `<div class="compare-row" style="grid-template-columns: 1fr auto auto;"><span>${marca} ${pick.label}</span><span class="grid-plain" style="color:${colorPick(pick.prob)}">${fmt(pick.prob)}%</span><span class="grid-plain" style="font-size:0.75rem;">${realDetalle} ${valorBadge}</span></div>`;
    }).join('');
    return `<div class="card"><h3 style="font-size:1rem;">${r.local} vs ${r.visitante}</h3><p style="margin:2px 0 8px; font-size:0.75rem; color:var(--chalk-dim);">${fechaCorta} · ${realTxt}</p>${picksHTML}</div>`;
  }).join('');

  picksContent.innerHTML = resumenHTML + `<h2 style="font-family:'Anton',sans-serif;font-size:1.15rem;letter-spacing:0.02em;color:var(--chalk);margin:20px 0 10px;">Detalle por partido (${ordenados.length}${ordenados.length > 50 ? ', mostrando 50' : ''})</h2>${cards || '<div class="card"><p style="color:var(--chalk-dim);">Sin partidos con picks.</p></div>'}`;
}

runBtn.addEventListener('click', async () => {
  if (!historial) return;
  runBtn.disabled = true;
  runBtn.textContent = 'Calculando...';
  logDiv.textContent = '';
  resultsSection.style.display = 'none';
  exportSection.style.display = 'none';
  calibrationSection.style.display = 'none';
  picksSection.style.display = 'none';
  filasComparacion = [];

  const leagueKey = historial.leagueKey;
  const partidos = historial.partidos;
  const umbrales = getUmbrales(leagueKey);

  const calResult = await calibrarLiga(leagueKey, partidos);
  const calibracion = calResult.calibracion;
  const tasas = calResult.tasas;
  renderCalibracion(calResult);

  log(`\n▶ Corriendo backtest con calibración ${calibracion ? 'ACTIVA' : 'por defecto'}...`);
  log(`   Filtro EV ≥ ${FILTRO_EV} aplicado a picks con cuota.`);
  log(`   Umbrales ${leagueKey}: 1X2 ≥${umbrales.umbral1x2}% · Goles ≥${umbrales.umbralGoles}% · BTTS ≥${umbrales.umbralBtss}% · Córners totales ≥${umbrales.umbralCorners}%`);

  const markets = {
    local: new MarketStats('Local gana'), empate: new MarketStats('Empate'), visitante: new MarketStats('Visitante gana'),
    over15: new MarketStats('Over 1.5 goles'), over25: new MarketStats('Over 2.5 goles'), over35: new MarketStats('Over 3.5 goles'),
    btts: new MarketStats('Ambos marcan'),
    corners75: new MarketStats('Over 7.5 córners'), corners85: new MarketStats('Over 8.5 córners'), corners95: new MarketStats('Over 9.5 córners'),
  };
  const mercado = {
    local: new MarketStats('Local gana'), empate: new MarketStats('Empate'), visitante: new MarketStats('Visitante gana'),
    over15: new MarketStats('Over 1.5 goles'), over25: new MarketStats('Over 2.5 goles'), over35: new MarketStats('Over 3.5 goles'), btts: new MarketStats('Ambos marcan'),
  };
  const modeloVsMercado = {
    local: new MarketStats('Local gana'), empate: new MarketStats('Empate'), visitante: new MarketStats('Visitante gana'),
    over15: new MarketStats('Over 1.5 goles'), over25: new MarketStats('Over 2.5 goles'), over35: new MarketStats('Over 3.5 goles'), btts: new MarketStats('Ambos marcan'),
  };

  const picksStats = new PicksStats(umbrales);
  const todasLasRecs = [];
  let evaluados = 0, saltados = 0, conSinEV = 0;

  for (const p of partidos) {
    if (p.goles_local == null || p.goles_visitante == null || !p.local || !p.visitante) { saltados++; continue; }
    let pred;
    try { pred = await simulateMatch(leagueKey, p.local, p.visitante, { staticOnly: true, calibracion }); }
    catch (e) { saltados++; continue; }

    const resultProbsFinal = SHRINK_ALPHA > 0 && tasas ? shrinkHaciaBase(pred.resultProbs, tasas, SHRINK_ALPHA) : pred.resultProbs;
    const rec = calcularRecomendacion(p, pred, resultProbsFinal, leagueKey);
    if (rec.sinEV.length > 0) conSinEV++;
    todasLasRecs.push(rec);
    picksStats.add(rec);

    const totalGoles = p.goles_local + p.goles_visitante;
    const resultado = p.goles_local > p.goles_visitante ? 'local' : p.goles_local < p.goles_visitante ? 'visitante' : 'empate';

    markets.local.add(resultProbsFinal.local, resultado === 'local');
    markets.empate.add(resultProbsFinal.empate, resultado === 'empate');
    markets.visitante.add(resultProbsFinal.visitante, resultado === 'visitante');
    markets.over15.add(pred.over15, totalGoles > 1.5);
    markets.over25.add(pred.over25, totalGoles > 2.5);
    markets.over35.add(pred.over35, totalGoles > 3.5);
    markets.btts.add(pred.btts, p.goles_local > 0 && p.goles_visitante > 0);

    if (p.odds_local != null && p.odds_empate != null && p.odds_visitante != null) {
      const [fL, fE, fV] = devigar3(p.odds_local, p.odds_empate, p.odds_visitante) || [];
      if (fL != null) {
        mercado.local.add(fL, resultado === 'local');
        mercado.empate.add(fE, resultado === 'empate');
        mercado.visitante.add(fV, resultado === 'visitante');
        modeloVsMercado.local.add(resultProbsFinal.local, resultado === 'local');
        modeloVsMercado.empate.add(resultProbsFinal.empate, resultado === 'empate');
        modeloVsMercado.visitante.add(resultProbsFinal.visitante, resultado === 'visitante');
      }
    }
    const fOver15 = devigar2(p.odds_over15, p.odds_under15);
    if (fOver15 != null) { mercado.over15.add(fOver15, totalGoles > 1.5); modeloVsMercado.over15.add(pred.over15, totalGoles > 1.5); }
    const fOver25 = devigar2(p.odds_over25, p.odds_under25);
    if (fOver25 != null) { mercado.over25.add(fOver25, totalGoles > 2.5); modeloVsMercado.over25.add(pred.over25, totalGoles > 2.5); }
    const fOver35 = devigar2(p.odds_over35, p.odds_under35);
    if (fOver35 != null) { mercado.over35.add(fOver35, totalGoles > 3.5); modeloVsMercado.over35.add(pred.over35, totalGoles > 3.5); }
    const fBtts = devigar2(p.odds_btts_si, p.odds_btts_no);
    if (fBtts != null) { mercado.btts.add(fBtts, p.goles_local > 0 && p.goles_visitante > 0); modeloVsMercado.btts.add(pred.btts, p.goles_local > 0 && p.goles_visitante > 0); }

    if (p.corners_local != null && p.corners_visitante != null && pred.cornerProbs) {
      const totalCorners = p.corners_local + p.corners_visitante;
      markets.corners75.add(pred.cornerProbs.over7, totalCorners > 7.5);
      markets.corners85.add(pred.cornerProbs.over8, totalCorners > 8.5);
      markets.corners95.add(pred.cornerProbs.over9, totalCorners > 9.5);
    }

    filasComparacion.push({
      fecha: p.fecha ?? '', local: p.local, visitante: p.visitante,
      app: { local: resultProbsFinal.local, empate: resultProbsFinal.empate, visitante: resultProbsFinal.visitante, over15: pred.over15, over25: pred.over25, over35: pred.over35, btts: pred.btts, corners_over75: pred.cornerProbs?.over7 ?? null, corners_over85: pred.cornerProbs?.over8 ?? null, corners_over95: pred.cornerProbs?.over9 ?? null },
      real: { goles_local: p.goles_local, goles_visitante: p.goles_visitante, total_goles: totalGoles, resultado, over15: totalGoles > 1.5 ? 1 : 0, over25: totalGoles > 2.5 ? 1 : 0, over35: totalGoles > 3.5 ? 1 : 0, btts: (p.goles_local > 0 && p.goles_visitante > 0) ? 1 : 0, corners_local: p.corners_local ?? null, corners_visitante: p.corners_visitante ?? null, corners_total: (p.corners_local != null && p.corners_visitante != null) ? p.corners_local + p.corners_visitante : null },
      casa: { odds_local: p.odds_local ?? null, odds_empate: p.odds_empate ?? null, odds_visitante: p.odds_visitante ?? null, odds_over15: p.odds_over15 ?? null, odds_under15: p.odds_under15 ?? null, odds_over25: p.odds_over25 ?? null, odds_under25: p.odds_under25 ?? null, odds_over35: p.odds_over35 ?? null, odds_under35: p.odds_under35 ?? null, odds_btts_si: p.odds_btts_si ?? null, odds_btts_no: p.odds_btts_no ?? null },
    });
    evaluados++;
    if (evaluados % 20 === 0) log(`  ${evaluados}/${partidos.length}...`);
  }

  log(`\n✅ Listo. ${evaluados} evaluados, ${saltados} salteados.`);
  log(`📋 Picks generados en ${picksStats.partidosConPick}/${evaluados} partidos.`);
  log(`🚫 ${conSinEV} partidos tenían picks potenciales que no pasaron el filtro EV.`);

  const mercadoResumen = {};
  for (const [k, m] of Object.entries(mercado)) mercadoResumen[k] = m.summary();
  const modeloVsMercadoResumen = {};
  for (const [k, m] of Object.entries(modeloVsMercado)) modeloVsMercadoResumen[k] = m.summary();

  try { renderPicks(todasLasRecs, picksStats.summary(), leagueKey); }
  catch (err) { console.error('❌ Error en renderPicks:', err); picksSection.style.display = 'block'; picksContent.innerHTML = `<div class="card"><h3>⚠️ Error al renderizar picks</h3><p style="color:var(--red);font-size:0.8rem;">${err.message}</p></div>`; }

  try { renderResults(Object.entries(markets).map(([k, m]) => ({ key: k, ...m.summary() })), mercadoResumen, modeloVsMercadoResumen); }
  catch (err) { console.error('❌ Error en renderResults:', err); resultsSection.style.display = 'block'; resultsContent.innerHTML = `<div class="card"><h3>⚠️ Error al renderizar resultados</h3><p style="color:var(--red);font-size:0.8rem;">${err.message}</p></div>`; }

  calibrationSection.style.display = 'block';
  picksSection.style.display = 'block';
  resultsSection.style.display = 'block';
  exportSection.style.display = 'block';
  runBtn.disabled = false;
  runBtn.textContent = 'Ejecutar backtest';
});

function vsBaseColor(m) { return m == null ? 'var(--chalk-dim)' : m >= 10 ? 'var(--green)' : m >= 0 ? 'var(--yellow)' : 'var(--red)'; }
function vsBaseNote(m, baseRate) {
  if (m == null) return '';
  const br = baseRate * 100; const signo = m >= 0 ? '+' : '';
  if (m >= 10) return `${signo}${fmt(m)}% mejor que solo saber que esto pasa ${fmt(br)}% de las veces`;
  if (m >= 0) return `${signo}${fmt(m)}% mejor que adivinar el ${fmt(br)}% de siempre`;
  return `${fmt(m)}% peor que adivinar el ${fmt(br)}% de siempre`;
}
function bucketRows(buckets) {
  return Object.entries(buckets).filter(([, v]) => v[1] > 0).map(([range, [hits, total]]) => `<div class="compare-row"><span>Predijo ${range}%</span><span class="grid-plain">${total} partidos</span><span class="grid-plain">pasó ${fmt(hits / total * 100)}%</span></div>`).join('');
}
function vsMercadoColor(m) { return m == null ? 'var(--chalk-dim)' : m > 2 ? 'var(--green)' : m >= -2 ? 'var(--yellow)' : 'var(--red)'; }
function vsMercadoNote(modeloSum, mercadoSum) {
  if (!mercadoSum || mercadoSum.n < 20) return null;
  const mejora = ((mercadoSum.brier - modeloSum.brier) / mercadoSum.brier) * 100;
  const signo = mejora >= 0 ? '+' : '';
  let texto;
  if (mejora > 2) texto = `${signo}${fmt(mejora)}% mejor que la cuota real`;
  else if (mejora >= -2) texto = `${signo}${fmt(mejora)}% — prácticamente empatado con la cuota real`;
  else texto = `${fmt(mejora)}% peor que la cuota real`;
  return { texto, mejora, n: mercadoSum.n };
}
function renderResults(summaries, mercadoResumen = {}, modeloVsMercadoResumen = {}) {
  const conDatos = summaries.filter(s => s.n > 0);
  if (conDatos.length === 0) { resultsContent.innerHTML = `<div class="card"><h3>Sin datos suficientes</h3></div>`; resultsSection.style.display = 'block'; return; }
  resultsContent.innerHTML = conDatos.map(s => {
    const vColor = vsBaseColor(s.mejoraVsBase);
    const rows = bucketRows(s.buckets);
    const mComp = s.key ? vsMercadoNote(modeloVsMercadoResumen[s.key], mercadoResumen[s.key]) : null;
    return `<div class="card"><h3>${s.name} <small>(${s.n} partidos)</small></h3><div class="prob-row"><div class="prob-row-top"><span>Acierto (umbral 50%)</span><span class="prob" style="color:${s.hitRate >= 55 ? 'var(--green)' : s.hitRate >= 48 ? 'var(--yellow)' : 'var(--red)'}">${fmt(s.hitRate)}%</span></div><div class="semaforo-track"><div class="semaforo-fill" style="width:${s.hitRate}%;background:${s.hitRate >= 55 ? 'var(--green)' : s.hitRate >= 48 ? 'var(--yellow)' : 'var(--red)'}"></div></div></div><div class="prob-row-top" style="margin-top:10px;"><span>Brier score</span><span class="prob">${s.brier.toFixed(3)}</span></div><p style="margin:4px 0 0; font-size:0.8rem; color:${vColor}">${vsBaseNote(s.mejoraVsBase, s.baseRate)}</p>${mComp ? `<p style="margin:8px 0 0; padding-top:8px; border-top:1px dashed var(--line); font-size:0.8rem; color:${vsMercadoColor(mComp.mejora)}"><strong>vs. cuota real (${mComp.n}):</strong> ${mComp.texto}</p>` : ''}${rows ? `<h3 class="corner-team-title">Calibración</h3>${rows}` : ''}</div>`;
  }).join('');
  resultsSection.style.display = 'block';
}

function exportarComparacionCSV(filas) {
  if (!filas.length) { alert('No hay partidos para exportar.'); return; }
  const headers = ['fecha','local','visitante','APP_local','APP_empate','APP_visitante','APP_over15','APP_over25','APP_over35','APP_btts','APP_corners_over75','APP_corners_over85','APP_corners_over95','REAL_goles_local','REAL_goles_visitante','REAL_total_goles','REAL_resultado','REAL_over15','REAL_over25','REAL_over35','REAL_btts','REAL_corners_local','REAL_corners_visitante','REAL_corners_total','CASA_odds_local','CASA_odds_empate','CASA_odds_visitante','CASA_fair_local','CASA_fair_empate','CASA_fair_visitante','CASA_odds_over15','CASA_odds_under15','CASA_fair_over15','CASA_odds_over25','CASA_odds_under25','CASA_fair_over25','CASA_odds_over35','CASA_odds_under35','CASA_fair_over35','CASA_odds_btts_si','CASA_odds_btts_no','CASA_fair_btts_si'];
  const escapar = (v) => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const num = (v) => (v == null || !Number.isFinite(v)) ? '' : Number(v).toFixed(2);
  const lineas = [headers.join(',')];
  for (const f of filas) {
    const dev3 = devigar3(f.casa.odds_local, f.casa.odds_empate, f.casa.odds_visitante);
    const fairL = dev3 ? dev3[0] : null, fairE = dev3 ? dev3[1] : null, fairV = dev3 ? dev3[2] : null;
    const fairO15 = devigar2(f.casa.odds_over15, f.casa.odds_under15);
    const fairO25 = devigar2(f.casa.odds_over25, f.casa.odds_under25);
    const fairO35 = devigar2(f.casa.odds_over35, f.casa.odds_under35);
    const fairBttsSi = devigar2(f.casa.odds_btts_si, f.casa.odds_btts_no);
    lineas.push([f.fecha, f.local, f.visitante, num(f.app.local), num(f.app.empate), num(f.app.visitante), num(f.app.over15), num(f.app.over25), num(f.app.over35), num(f.app.btts), num(f.app.corners_over75), num(f.app.corners_over85), num(f.app.corners_over95), f.real.goles_local, f.real.goles_visitante, f.real.total_goles, f.real.resultado, f.real.over15, f.real.over25, f.real.over35, f.real.btts, f.real.corners_local ?? '', f.real.corners_visitante ?? '', f.real.corners_total ?? '', f.casa.odds_local ?? '', f.casa.odds_empate ?? '', f.casa.odds_visitante ?? '', num(fairL), num(fairE), num(fairV), f.casa.odds_over15 ?? '', f.casa.odds_under15 ?? '', num(fairO15), f.casa.odds_over25 ?? '', f.casa.odds_under25 ?? '', num(fairO25), f.casa.odds_over35 ?? '', f.casa.odds_under35 ?? '', num(fairO35), f.casa.odds_btts_si ?? '', f.casa.odds_btts_no ?? '', num(fairBttsSi)].map(escapar).join(','));
  }
  const csv = '\uFEFF' + lineas.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const ligaSlug = String(historial?.liga || historial?.leagueKey || 'backtest').replace(/\s+/g, '_');
  a.download = `comparacion_${ligaSlug}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
exportBtn.addEventListener('click', () => exportarComparacionCSV(filasComparacion));

const exportParamsBtn = document.getElementById('export-params-btn');
if (exportParamsBtn) {
  exportParamsBtn.addEventListener('click', () => {
    AutoCalibrate.exportarParamsJSON();
  });
}
