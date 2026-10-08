// calibrate.js
// Calibración automática por liga a partir del historial real.
// No requiere edición manual de leagues.js: deriva HOME_ADVANTAGE y RHO
// óptimos desde las tasas base observadas en el propio historial.

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

// Ajuste con damping. Dada la tasa real y la predicha (probabilidad media),
// mueve homeAdv en la dirección correcta sin oscilar.
export function ajustarHomeAdvantage(homeAdvActual, tasas, predHomeRate) {
  const ratio = (tasas.homeRate + 0.02) / (predHomeRate + 0.02);
  const ajuste = Math.pow(ratio, 0.35);
  return Math.max(1.0, Math.min(1.6, homeAdvActual * ajuste));
}

// Ajuste de rho con límites ampliados.
// El rango original era [-0.25, +0.05], pero ligas como Premier League
// necesitan valores más negativos para capturar su tasa real de empates.
// El rango ampliado es [-0.35, +0.05]. Es solo un techo — las ligas que no
// lo necesiten no se ven afectadas.
export function ajustarRho(rhoActual, tasas, predDrawRate) {
  const diff = tasas.drawRate - predDrawRate;
  const nuevo = rhoActual - diff * 0.8;
  return Math.max(-0.35, Math.min(0.15, nuevo));
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
