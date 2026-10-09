// calibrate.js
// Calibración por liga a partir del historial real.
//
// v2: HOME_ADVANTAGE y RHO se estiman por MÁXIMA VEROSIMILITUD sobre los
// marcadores reales (no igualando tasas agregadas de L/E/V, que hacía que rho
// absorbiera sesgos de los ratings y se pegara al límite). Incluye:
//   - prior suave hacia los valores de leagues.js (estabiliza muestras chicas)
//   - hold-out cronológico: los parámetros nuevos solo se aceptan si NO empeoran
//     la verosimilitud en los partidos más recientes que no usaron para ajustar
//   - límites de rho/HA válidos (sin probabilidades negativas)

import {
  LIGAS, HOME_ADVANTAGE, DIXON_COLES_RHO, DEFAULT_HOME_ADV, DEFAULT_RHO,
  HA_MIN, HA_MAX, RHO_MIN, RHO_MAX, GOALS_AVG_PRIOR_MATCHES,
} from './leagues.js';
import { simulateMatch, getStaticRating, calcLambdas } from './model.js';
import { logLikMarcador } from './stats.js';

export function calcularTasasBase(partidos) {
  let n = 0, loc = 0, emp = 0, vis = 0;
  let sumaGoles = 0, sumaCorners = 0, nCorners = 0;
  for (const p of partidos) {
    if (p.goles_local == null || p.goles_visitante == null) continue;
    n++;
    sumaGoles += p.goles_local + p.goles_visitante;
    if (p.goles_local > p.goles_visitante) loc++;
    else if (p.goles_local === p.goles_visitante) emp++;
    else vis++;
    if (p.corners_local != null && p.corners_visitante != null) {
      sumaCorners += p.corners_local + p.corners_visitante;
      nCorners++;
    }
  }
  return {
    n,
    homeRate: n ? loc / n : 0.45,
    drawRate: n ? emp / n : 0.27,
    awayRate: n ? vis / n : 0.28,
    goalsAvg: n ? sumaGoles / n : 2.5,
    cornAvg: nCorners ? sumaCorners / nCorners : 10,
  };
}

// Deja los parámetros dentro de rangos válidos (por si vienen de un archivo viejo).
export function sanearParams(p) {
  if (!p || !Number.isFinite(p.homeAdvantage) || !Number.isFinite(p.rho)) return null;
  const out = {
    homeAdvantage: Math.min(HA_MAX, Math.max(HA_MIN, p.homeAdvantage)),
    rho: Math.min(RHO_MAX, Math.max(RHO_MIN, p.rho)),
  };
  if (Number.isFinite(p.goalsAvg) && p.goalsAvg >= 1.2 && p.goalsAvg <= 4.5) out.goalsAvg = p.goalsAvg;
  return out;
}

// ---- Ajustes heurísticos (se conservan por compatibilidad; ya no se usan) ----
export function ajustarHomeAdvantage(homeAdvActual, tasas, predHomeRate) {
  const ratio = (tasas.homeRate + 0.02) / (predHomeRate + 0.02);
  const ajuste = Math.pow(ratio, 0.35);
  return Math.max(HA_MIN, Math.min(HA_MAX, homeAdvActual * ajuste));
}
export function ajustarRho(rhoActual, tasas, predDrawRate) {
  const diff = tasas.drawRate - predDrawRate;
  const nuevo = rhoActual - diff * 0.8;
  return Math.max(RHO_MIN, Math.min(RHO_MAX, nuevo));
}

// ---- Máxima verosimilitud ----
// SIGMA_HA controla cuánto se puede alejar HA del prior de leagues.js sin
// pagar penalización. Antes 0.15 permitía que HA se fuera a 1.37 cuando la
// ganancia en log-verosimilitud era estadísticamente nula (t≈0.84), pero
// empeoraba el error L/E/V de 6.7% a 8.3%. Con 0.10 el prior pesa más.
const SIGMA_HA = 0.10;
const SIGMA_RHO = 0.06;
const HOLDOUT_FRAC = 0.25;
const HOLDOUT_MIN_N = 40;
const Z_RECHAZO = 1.64; // se rechaza el ajuste solo si es peor con ~95% de confianza

function logLikPorPartido(matches, goalsAvg, ha, rho) {
  return matches.map(m => {
    const { lambdaHome, lambdaAway } = calcLambdas(goalsAvg, m.h, m.a, ha);
    return logLikMarcador(m.gl, m.gv, lambdaHome, lambdaAway, rho);
  });
}

function logLik(matches, goalsAvg, ha, rho) {
  let s = 0;
  for (const v of logLikPorPartido(matches, goalsAvg, ha, rho)) s += v;
  return s;
}

function ajustarGrilla(matches, goalsAvg, haPrior, rhoPrior) {
  let mejor = { ha: haPrior, rho: rhoPrior, obj: -Infinity };
  for (let ha = HA_MIN; ha <= HA_MAX + 1e-9; ha += 0.01) {
    for (let rho = RHO_MIN; rho <= RHO_MAX + 1e-9; rho += 0.01) {
      const pen = 0.5 * (((ha - haPrior) / SIGMA_HA) ** 2 + ((rho - rhoPrior) / SIGMA_RHO) ** 2);
      const obj = logLik(matches, goalsAvg, ha, rho) - pen;
      if (obj > mejor.obj) mejor = { ha, rho, obj };
    }
  }
  return { ha: +mejor.ha.toFixed(3), rho: +mejor.rho.toFixed(3) };
}

export async function calibrarLigaMLE(leagueKey, partidosIn, { onLog = null, minPartidos = 20 } = {}) {
  const log = (m) => { if (onLog) onLog(m); };
  const liga = LIGAS[leagueKey];
  const todos = [...partidosIn]
    .filter(p => p.goles_local != null && p.goles_visitante != null && p.local && p.visitante)
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  const tasas = calcularTasasBase(todos);

  // Solo se usan partidos donde ambos equipos tienen rating estático.
  const matches = [];
  for (const p of todos) {
    const h = getStaticRating(leagueKey, p.local);
    const a = getStaticRating(leagueKey, p.visitante);
    if (h && a) matches.push({ h, a, gl: p.goles_local, gv: p.goles_visitante, p });
  }
  const n = matches.length;
  const sinRating = todos.length - n;
  if (sinRating > 0) log(`   ℹ️ ${sinRating} partidos sin rating estático para algún equipo (no se usan para ajustar).`);
  if (n < minPartidos) {
    return { calibracion: null, razon: `Solo ${n} partidos utilizables`, tasas, historial: [], leagueKey };
  }

  const obsAvg = matches.reduce((s, m) => s + m.gl + m.gv, 0) / n;
  const goalsAvg = (n * obsAvg + GOALS_AVG_PRIOR_MATCHES * liga.goalsAvg) / (n + GOALS_AVG_PRIOR_MATCHES);
  const haPrior = HOME_ADVANTAGE[leagueKey] ?? DEFAULT_HOME_ADV;
  const rhoPrior = DIXON_COLES_RHO[leagueKey] ?? DIXON_COLES_RHO.default ?? DEFAULT_RHO;

  log(`   Goles/partido: real ${obsAvg.toFixed(2)} · liga (estático) ${liga.goalsAvg.toFixed(2)} · usado ${goalsAvg.toFixed(2)}`);

  let aceptado = true;
  let holdout = null;
  if (n >= HOLDOUT_MIN_N) {
    const nTest = Math.max(8, Math.round(n * HOLDOUT_FRAC));
    const train = matches.slice(0, n - nTest);
    const test = matches.slice(n - nTest);
    const fitTrain = ajustarGrilla(train, goalsAvg, haPrior, rhoPrior);
    const vFit = logLikPorPartido(test, goalsAvg, fitTrain.ha, fitTrain.rho);
    const vPrior = logLikPorPartido(test, goalsAvg, haPrior, rhoPrior);
    const d = vFit.map((v, i) => v - vPrior[i]);
    const media = d.reduce((x, y) => x + y, 0) / nTest;
    const varianza = d.reduce((x, y) => x + (y - media) ** 2, 0) / Math.max(1, nTest - 1);
    const se = Math.sqrt(varianza / nTest);
    const llFit = vFit.reduce((x, y) => x + y, 0) / nTest;
    const llPrior = vPrior.reduce((x, y) => x + y, 0) / nTest;
    aceptado = media >= -Z_RECHAZO * se;
    holdout = { nTest, llFit: +llFit.toFixed(4), llPrior: +llPrior.toFixed(4), mejora: +media.toFixed(4), se: +se.toFixed(4), aceptado };
    log(`   Hold-out (${nTest} partidos recientes): log-verosim. ajustado ${llFit.toFixed(3)} vs base ${llPrior.toFixed(3)} (dif ${media.toFixed(4)} ± ${se.toFixed(4)}) → ${aceptado ? '✓ se acepta' : '✗ es peor que el valor base, se mantiene el base'}`);
  } else {
    log(`   ⚠️ ${n} partidos: muestra chica, sin hold-out (prior fuerte hacia valores base).`);
  }

  const final = aceptado ? ajustarGrilla(matches, goalsAvg, haPrior, rhoPrior) : { ha: haPrior, rho: rhoPrior };
  const calibracion = { homeAdvantage: final.ha, rho: final.rho, goalsAvg: +goalsAvg.toFixed(3) };
  log(`   HA=${final.ha.toFixed(3)} · rho=${final.rho.toFixed(3)} (base ${haPrior.toFixed(3)} / ${rhoPrior.toFixed(3)})`);

  // Diagnóstico: tasas L/E/V que predice el modelo vs las reales.
  const paso = Math.max(1, Math.floor(n / 80));
  let sL = 0, sE = 0, sV = 0, k = 0;
  for (let i = 0; i < n; i += paso) {
    const p = matches[i].p;
    try {
      const pred = await simulateMatch(leagueKey, p.local, p.visitante, { staticOnly: true, calibracion });
      sL += pred.resultProbs.local; sE += pred.resultProbs.empate; sV += pred.resultProbs.visitante; k++;
    } catch (e) { /* skip */ }
  }
  const predHome = k ? sL / k / 100 : 0, predDraw = k ? sE / k / 100 : 0, predAway = k ? sV / k / 100 : 0;
  const err = Math.abs(tasas.homeRate - predHome) + Math.abs(tasas.drawRate - predDraw) + Math.abs(tasas.awayRate - predAway);
  const historial = [{ iter: 1, homeAdv: final.ha, rho: final.rho, predHome, predDraw, predAway, err }];
  log(`   Modelo medio L:${(predHome * 100).toFixed(1)}% E:${(predDraw * 100).toFixed(1)}% V:${(predAway * 100).toFixed(1)}% · real L:${(tasas.homeRate * 100).toFixed(1)}% E:${(tasas.drawRate * 100).toFixed(1)}% V:${(tasas.awayRate * 100).toFixed(1)}% (err ${(err * 100).toFixed(1)}%)`);

  return { calibracion, tasas, historial, error: err, diagnostico: { n, sinRating, holdout, aceptado }, leagueKey };
}

// Mezcla las probabilidades del modelo con las tasas base de la liga.
// alpha=0 → solo modelo. alpha=1 → solo tasa base. Default suave: 0.15.
export function shrinkHaciaBase(resultProbs, tasas, alpha = 0.15) {
  const modelo = {
    local: resultProbs.local,
    empate: resultProbs.empate,
    visitante: resultProbs.visitante,
  };
  const base = {
    local: tasas.homeRate * 100,
    empate: tasas.drawRate * 100,
    visitante: tasas.awayRate * 100,
  };
  const mezcla = {
    local: modelo.local * (1 - alpha) + base.local * alpha,
    empate: modelo.empate * (1 - alpha) + base.empate * alpha,
    visitante: modelo.visitante * (1 - alpha) + base.visitante * alpha,
  };
  const s = mezcla.local + mezcla.empate + mezcla.visitante;
  if (s <= 0) return resultProbs;
  return {
    local: +(mezcla.local / s * 100).toFixed(1),
    empate: +(mezcla.empate / s * 100).toFixed(1),
    visitante: +(mezcla.visitante / s * 100).toFixed(1),
  };
}
