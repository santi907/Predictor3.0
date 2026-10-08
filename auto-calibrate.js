// auto-calibrate.js
// Recalibra automáticamente cada 30 partidos nuevos, con ventana de 200.
// Guarda params en localStorage Y permite exportar a params.json.

import { LIGAS, HOME_ADVANTAGE, DIXON_COLES_RHO } from './leagues.js';
import { simulateMatch } from './model.js';
import {
  calcularTasasBase,
  ajustarHomeAdvantage,
  ajustarRho,
} from './calibrate.js';

const STORAGE_PREFIX = 'autocal_';
const PARAMS_JSON_URL = './params.json';

export const AutoCalibrate = {
  CONFIG: {
    VENTANA: 200,
    PASO: 30,
    MAX_ITER: 10,
    MUESTRA: 60,
    MIN_PARTIDOS: 20,
    ERROR_CONV: 0.02,
  },

  // ============ CACHE DE params.json ============
  _paramsJSONCache: null,

  async cargarParamsJSON() {
    if (this._paramsJSONCache !== null) return this._paramsJSONCache;
    try {
      const res = await fetch(PARAMS_JSON_URL + '?t=' + Date.now());
      if (!res.ok) {
        this._paramsJSONCache = {};
        return {};
      }
      const data = await res.json();
      this._paramsJSONCache = data || {};
      console.log(`📂 params.json cargado (${Object.keys(this._paramsJSONCache).length} ligas)`);
      return this._paramsJSONCache;
    } catch (e) {
      console.warn('⚠️ No se pudo cargar params.json, usando localStorage:', e.message);
      this._paramsJSONCache = {};
      return {};
    }
  },

  // ============ ESTADO (localStorage) ============
  getEstado(ligaKey) {
    try {
      const raw = localStorage.getItem(`${STORAGE_PREFIX}${ligaKey}`);
      return raw ? JSON.parse(raw) : { partidosCalibrados: 0, params: null, ultima: null };
    } catch (e) {
      return { partidosCalibrados: 0, params: null, ultima: null };
    }
  },

  setEstado(ligaKey, estado) {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${ligaKey}`, JSON.stringify(estado));
    } catch (e) {
      console.warn('No se pudo guardar estado:', e);
    }
  },

  // ============ PARAMS ACTIVOS ============
  // Prioridad: localStorage (más reciente) > params.json > null
  async getParamsActivos(ligaKey) {
    // 1. localStorage (el usuario acaba de calibrar)
    const estado = this.getEstado(ligaKey);
    if (estado.params) {
      return { ...estado.params, fuente: 'local' };
    }

    // 2. params.json (del repo, sincronizado)
    const paramsJSON = await this.cargarParamsJSON();
    if (paramsJSON[ligaKey]?.params) {
      return { ...paramsJSON[ligaKey].params, fuente: 'repo' };
    }

    // 3. Nada
    return null;
  },

  // Versión sync (solo localStorage) — para compatibilidad
  getParamsActivosSync(ligaKey) {
    const estado = this.getEstado(ligaKey);
    return estado.params || null;
  },

  debeRecalibrar(ligaKey, partidos) {
    if (!partidos || partidos.length < this.CONFIG.MIN_PARTIDOS) return false;
    const estado = this.getEstado(ligaKey);
    const nuevos = partidos.length - estado.partidosCalibrados;
    return nuevos >= this.CONFIG.PASO || !estado.params;
  },

  // ============ CALIBRACIÓN ============
  async calibrar(ligaKey, partidos, onLog = null) {
    const log = (msg) => { if (onLog) onLog(msg); };

    const tasas = calcularTasasBase(partidos);
    if (tasas.n < this.CONFIG.MIN_PARTIDOS) {
      return { calibracion: null, razon: `Solo ${tasas.n} partidos` };
    }

    let homeAdv = HOME_ADVANTAGE[ligaKey] ?? 1.05;
    let rho = DIXON_COLES_RHO[ligaKey] ?? DIXON_COLES_RHO.default ?? -0.1;
    const historial = [];

    const muestra = [];
    const step = Math.max(1, Math.floor(partidos.length / this.CONFIG.MUESTRA));
    for (let i = 0; i < partidos.length && muestra.length < this.CONFIG.MUESTRA; i += step) {
      if (partidos[i].goles_local != null && partidos[i].local && partidos[i].visitante) {
        muestra.push(partidos[i]);
      }
    }

    for (let iter = 0; iter < this.CONFIG.MAX_ITER; iter++) {
      let sumL = 0, sumE = 0, sumV = 0, n = 0;
      for (const p of muestra) {
        try {
          const pred = await simulateMatch(ligaKey, p.local, p.visitante, {
            staticOnly: true,
            calibracion: { homeAdvantage: homeAdv, rho }
          });
          sumL += pred.resultProbs.local;
          sumE += pred.resultProbs.empate;
          sumV += pred.resultProbs.visitante;
          n++;
        } catch (e) { /* skip */ }
      }
      if (n === 0) break;

      const predHomeRate = sumL / n / 100;
      const predDrawRate = sumE / n / 100;
      const predAwayRate = sumV / n / 100;
      const err = Math.abs(tasas.homeRate - predHomeRate)
                + Math.abs(tasas.drawRate - predDrawRate)
                + Math.abs(tasas.awayRate - predAwayRate);

      historial.push({
        iter: iter + 1, homeAdv, rho,
        predHome: predHomeRate, predDraw: predDrawRate, predAway: predAwayRate, err
      });

      log(`   [iter ${iter + 1}] homeAdv=${homeAdv.toFixed(3)} rho=${rho.toFixed(3)} → L:${(predHomeRate*100).toFixed(1)}% E:${(predDrawRate*100).toFixed(1)}% V:${(predAwayRate*100).toFixed(1)}% (err ${(err*100).toFixed(1)}%)`);

      if (err < this.CONFIG.ERROR_CONV) {
        log(`   ✓ Convergió (error < 2%)`);
        break;
      }

      homeAdv = ajustarHomeAdvantage(homeAdv, tasas, predHomeRate);
      rho = ajustarRho(rho, tasas, predDrawRate);
    }

    return {
      calibracion: { homeAdvantage: homeAdv, rho },
      tasas,
      historial,
      error: historial[historial.length - 1]?.err ?? 1,
    };
  },

  // ============ FLUJO PRINCIPAL ============
  async ejecutar(ligaKey, partidos, { force = false, onLog = null } = {}) {
    const log = (msg) => { if (onLog) onLog(msg); console.log(msg); };

    if (!partidos || partidos.length < this.CONFIG.MIN_PARTIDOS) {
      log(`⚠️ ${ligaKey}: solo ${partidos?.length || 0} partidos — no se calibra`);
      return { recalibrado: false, params: await this.getParamsActivos(ligaKey) };
    }

    partidos = [...partidos].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

    const estado = this.getEstado(ligaKey);
    const nuevos = partidos.length - estado.partidosCalibrados;
    const debe = force || nuevos >= this.CONFIG.PASO || !estado.params;

    if (!debe) {
      log(`⏳ ${ligaKey}: usando params previos (faltan ${this.CONFIG.PASO - nuevos} partidos para recalibrar)`);
      return { recalibrado: false, params: estado.params };
    }

    log(`🔄 ${ligaKey}: recalibrando con ventana de ${this.CONFIG.VENTANA} partidos...`);
    const ventana = partidos.slice(-this.CONFIG.VENTANA);
    const resultado = await this.calibrar(ligaKey, ventana, log);

    if (!resultado.calibracion) {
      log(`❌ ${ligaKey}: ${resultado.razon}`);
      return { recalibrado: false, params: estado.params };
    }

    const nuevoEstado = {
      partidosCalibrados: partidos.length,
      params: resultado.calibracion,
      ultima: new Date().toISOString(),
      tasas: resultado.tasas,
      error: resultado.error,
    };
    this.setEstado(ligaKey, nuevoEstado);

    log(`✅ ${ligaKey}: HA=${resultado.calibracion.homeAdvantage.toFixed(3)}, rho=${resultado.calibracion.rho.toFixed(3)}, err=${(resultado.error * 100).toFixed(1)}%`);
    log(`💾 Parámetros guardados en localStorage (${partidos.length} partidos calibrados)`);

    return { recalibrado: true, params: resultado.calibracion, historial: resultado.historial };
  },

  // ============ EXPORTAR PARAMS.JSON ============
  exportarParamsJSON() {
    const params = {};
    for (const key of Object.keys(LIGAS)) {
      const estado = this.getEstado(key);
      if (estado.params) {
        params[key] = {
          params: estado.params,
          partidosCalibrados: estado.partidosCalibrados,
          ultima: estado.ultima,
          error: estado.error,
        };
      }
    }
    if (Object.keys(params).length === 0) {
      alert('No hay params guardados para exportar. Corré el backtest primero.');
      return;
    }
    const json = JSON.stringify(params, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'params.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    console.log(`📥 params.json descargado (${Object.keys(params).length} ligas)`);
  },

  // ============ RESET ============
  reset(ligaKey) {
    localStorage.removeItem(`${STORAGE_PREFIX}${ligaKey}`);
  },
  resetAll() {
    for (const key of Object.keys(LIGAS)) {
      localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
    }
  },

  // ============ REPORTE ============
  getReporte() {
    const reporte = {};
    for (const key of Object.keys(LIGAS)) {
      const estado = this.getEstado(key);
      if (estado.params) {
        reporte[key] = {
          nombre: LIGAS[key].name,
          params: estado.params,
          partidosCalibrados: estado.partidosCalibrados,
          ultima: estado.ultima,
          error: estado.error,
          fuente: 'local',
        };
      }
    }
    return reporte;
  },
};
