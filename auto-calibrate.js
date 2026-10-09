// auto-calibrate.js
// Recalibra automáticamente cada 30 partidos nuevos, con ventana de 200.
// Guarda params en localStorage Y permite exportar a params.json.
// v2: usa calibración por máxima verosimilitud (calibrate.js) e ignora params
// guardados con otra versión del modelo (MODEL_VERSION).

import { LIGAS, MODEL_VERSION } from './leagues.js';
import { calibrarLigaMLE, sanearParams } from './calibrate.js';

const STORAGE_PREFIX = 'autocal_';
const PARAMS_JSON_URL = './params.json';

// Valida tasas guardadas (fracciones que suman ~1). Si están corruptas o
// vienen de un formato viejo, devuelve null y el shrinkage simplemente no se
// aplica — mejor eso que shrinkear hacia una base mal calculada.
function sanearTasas(t) {
  if (!t) return null;
  const { homeRate, drawRate, awayRate } = t;
  if (![homeRate, drawRate, awayRate].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) return null;
  const suma = homeRate + drawRate + awayRate;
  if (Math.abs(suma - 1) > 0.15) return null; // no suman ~1, dato corrupto
  return {
    homeRate, drawRate, awayRate,
    n: Number.isFinite(t.n) ? t.n : undefined,
  };
}

export const AutoCalibrate = {
  CONFIG: {
    VENTANA: 200,
    PASO: 30,
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
      if (!raw) return { partidosCalibrados: 0, params: null, ultima: null };
      const est = JSON.parse(raw);
      // Parámetros calibrados con otra versión del modelo: se descartan.
      if (est.v !== MODEL_VERSION) return { partidosCalibrados: 0, params: null, ultima: null };
      return est;
    } catch (e) {
      return { partidosCalibrados: 0, params: null, ultima: null };
    }
  },

  setEstado(ligaKey, estado) {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${ligaKey}`, JSON.stringify({ ...estado, v: MODEL_VERSION }));
    } catch (e) {
      console.warn('No se pudo guardar estado:', e);
    }
  },

  // ============ PARAMS ACTIVOS ============
  // Prioridad: localStorage (más reciente) > params.json > null
  async getParamsActivos(ligaKey) {
    // 1. localStorage (el usuario acaba de calibrar)
    const estado = this.getEstado(ligaKey);
    const local = sanearParams(estado.params);
    if (local) {
      return { ...local, fuente: 'local', tasas: sanearTasas(estado.tasas) };
    }

    // 2. params.json (del repo, sincronizado). Se ignoran entradas de otra versión.
    const paramsJSON = await this.cargarParamsJSON();
    const entrada = paramsJSON[ligaKey];
    if (entrada?.params && entrada.v === MODEL_VERSION) {
      const repo = sanearParams(entrada.params);
      if (repo) return { ...repo, fuente: 'repo', tasas: sanearTasas(entrada.tasas) };
    }

    // 3. Nada
    return null;
  },

  // Versión sync (solo localStorage) — para compatibilidad
  getParamsActivosSync(ligaKey) {
    const estado = this.getEstado(ligaKey);
    return sanearParams(estado.params);
  },

  debeRecalibrar(ligaKey, partidos) {
    if (!partidos || partidos.length < this.CONFIG.MIN_PARTIDOS) return false;
    const estado = this.getEstado(ligaKey);
    const nuevos = partidos.length - estado.partidosCalibrados;
    return nuevos >= this.CONFIG.PASO || !estado.params;
  },

  // ============ CALIBRACIÓN ============
  async calibrar(ligaKey, partidos, onLog = null) {
    const r = await calibrarLigaMLE(ligaKey, partidos, { onLog, minPartidos: this.CONFIG.MIN_PARTIDOS });
    if (!r.calibracion) {
      return {
        calibracion: null,
        razon: r.razon,
        tasas: r.tasas,
        historial: r.historial || [],
        diagnostico: r.diagnostico,
      };
    }
    return {
      calibracion: r.calibracion,
      tasas: r.tasas,
      historial: r.historial,
      error: r.error,
      diagnostico: r.diagnostico,
    };
  },

  // ============ FLUJO PRINCIPAL ============
  async ejecutar(ligaKey, partidos, { force = false, onLog = null } = {}) {
    const log = (msg) => { if (onLog) onLog(msg); console.log(msg); };

    if (!partidos || partidos.length < this.CONFIG.MIN_PARTIDOS) {
      log(`⚠️ ${ligaKey}: solo ${partidos?.length || 0} partidos — no se calibra`);
      return {
        recalibrado: false,
        razon: `solo ${partidos?.length || 0} partidos (mínimo ${this.CONFIG.MIN_PARTIDOS})`,
        calibracion: null,
        params: await this.getParamsActivos(ligaKey),
        tasas: null,
        historial: [],
      };
    }

    partidos = [...partidos].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

    const estado = this.getEstado(ligaKey);
    const nuevos = partidos.length - estado.partidosCalibrados;
    const debe = force || nuevos >= this.CONFIG.PASO || !estado.params;

    if (!debe) {
      log(`⏳ ${ligaKey}: usando params previos (faltan ${this.CONFIG.PASO - nuevos} partidos para recalibrar)`);
      return {
        recalibrado: false,
        razon: 'params previos vigentes',
        calibracion: estado.params,
        params: estado.params,
        tasas: sanearTasas(estado.tasas),
        historial: [],
      };
    }

    log(`🔄 ${ligaKey}: recalibrando con ventana de ${this.CONFIG.VENTANA} partidos...`);
    const ventana = partidos.slice(-this.CONFIG.VENTANA);
    const resultado = await this.calibrar(ligaKey, ventana, log);

    if (!resultado.calibracion) {
      log(`❌ ${ligaKey}: ${resultado.razon}`);
      return {
        recalibrado: false,
        razon: resultado.razon,
        calibracion: null,
        params: estado.params,
        tasas: resultado.tasas,
        historial: resultado.historial || [],
        diagnostico: resultado.diagnostico,
      };
    }

    const nuevoEstado = {
      partidosCalibrados: partidos.length,
      params: resultado.calibracion,
      ultima: new Date().toISOString(),
      tasas: {
        homeRate: resultado.tasas.homeRate,
        drawRate: resultado.tasas.drawRate,
        awayRate: resultado.tasas.awayRate,
        n: resultado.tasas.n,
      },
      error: resultado.error,
    };
    this.setEstado(ligaKey, nuevoEstado);

    log(`✅ ${ligaKey}: HA=${resultado.calibracion.homeAdvantage.toFixed(3)}, rho=${resultado.calibracion.rho.toFixed(3)}, goles/partido=${resultado.calibracion.goalsAvg}, err L/E/V=${(resultado.error * 100).toFixed(1)}%`);
    log(`💾 Parámetros guardados en localStorage (${partidos.length} partidos calibrados)`);

    return {
      recalibrado: true,
      calibracion: resultado.calibracion,
      params: resultado.calibracion, // compatibilidad con la API previa
      tasas: resultado.tasas,
      historial: resultado.historial || [],
      error: resultado.error,
      diagnostico: resultado.diagnostico,
    };
  },

  // ============ EXPORTAR PARAMS.JSON ============
  exportarParamsJSON() {
    const params = {};
    for (const key of Object.keys(LIGAS)) {
      const estado = this.getEstado(key);
      if (estado.params) {
        params[key] = {
          v: MODEL_VERSION,
          params: estado.params,
          tasas: estado.tasas ? { homeRate: estado.tasas.homeRate, drawRate: estado.tasas.drawRate, awayRate: estado.tasas.awayRate } : undefined,
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
