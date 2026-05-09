// src/server.js
// Worker HTTP que recibe requests de TrackIn-IA y procesa envios en Shalom Pro.

import express from 'express';
import { ShalomClient, ShalomError } from './shalom-client.js';
import { subirPedidoAShalom, clearShalomCache } from './shalom-service.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Auth interno entre Vercel y este worker (NO se expone a clientes finales)
const WORKER_API_KEY = process.env.WORKER_API_KEY || 'dev-secret-change-in-production';

// Credenciales Shalom Pro (en produccion vienen de env vars)
const SHALOM_EMAIL = process.env.SHALOM_EMAIL || 'Shalomproalt@gmail.com';
const SHALOM_PASSWORD = process.env.SHALOM_PASSWORD || 'Shalomproalt777$';
const SHALOM_TERMINAL_ORIGEN = parseInt(process.env.SHALOM_TERMINAL_ORIGEN) || 426; // Los Fresnos

// Datos del REMITENTE (vos como cliente Shalom)
const REMITENTE_DOC = process.env.SHALOM_REMITENTE_DOC || '74303615';

const DEBUG = process.env.DEBUG === '1' || process.env.NODE_ENV !== 'production';

// ─────────────────────────────────────────────────────
// Validacion de startup
// ─────────────────────────────────────────────────────
if (WORKER_API_KEY === 'dev-secret-change-in-production') {
  console.warn('⚠️  WORKER_API_KEY tiene valor default — configura la env var en produccion');
}
if (!SHALOM_EMAIL || !SHALOM_PASSWORD) {
  console.error('❌ SHALOM_EMAIL o SHALOM_PASSWORD no configurados');
}
if (isNaN(SHALOM_TERMINAL_ORIGEN)) {
  console.error('❌ SHALOM_TERMINAL_ORIGEN no es un numero valido');
}

// Anti-duplicados: set temporal de pedidos en proceso (evita doble guia si doble click)
const _pedidosEnProceso = new Set();

// Validar estructura minima de un pedido
function validarPedido(p) {
  if (!p || typeof p !== 'object') return 'Pedido invalido o vacio';
  if (!p.dni || String(p.dni).trim().length < 7) return 'DNI invalido o ausente (minimo 7 digitos)';
  if (!p.provincia && !p.ciudad && !p.shalomTerminalDestinoId) return 'Sin destino: falta provincia, ciudad o terminal Shalom';
  return null; // OK
}

// ─────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// Logger basico
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - t0}ms)`);
  });
  next();
});

// Auth middleware: requiere X-Worker-Key
function requireWorkerAuth(req, res, next) {
  const key = req.headers['x-worker-key'] || req.query.workerKey;
  if (!key || key !== WORKER_API_KEY) {
    return res.status(401).json({ error: 'Worker key invalida o ausente' });
  }
  next();
}

// ─────────────────────────────────────────────────────
// Endpoints publicos
// ─────────────────────────────────────────────────────

// Test boleta PDF download (temporal para debug)
app.get('/test-boleta/:oseId', requireWorkerAuth, async (req, res) => {
  try {
    // Test SVG → Cloudinary flow directly
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="300"><rect width="420" height="300" fill="white" rx="12"/><rect width="420" height="50" fill="#DC2626" rx="12 12 0 0"/><text x="20" y="35" font-family="Arial" font-size="20" font-weight="bold" fill="white">SHALOM TEST</text><text x="20" y="90" font-family="Courier" font-size="24" fill="#DC2626">N: ${req.params.oseId}</text><text x="20" y="130" font-family="Arial" font-size="14" fill="#333">TEST BOLETA</text><text x="210" y="250" font-family="Courier" font-size="28" font-weight="bold" fill="#DC2626" text-anchor="middle">1234</text></svg>`;
    const svgBase64 = Buffer.from(svg).toString('base64');
    const cloudName = process.env.CLOUDINARY_CLOUD || 'dnfgsdxan';
    const uploadPreset = process.env.CLOUDINARY_PRESET || 'EMPRESA';
    const formData = new URLSearchParams();
    formData.append('file', 'data:image/svg+xml;base64,' + svgBase64);
    formData.append('upload_preset', uploadPreset);
    formData.append('folder', 'boletas');
    const cloudRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: 'POST',
      body: formData
    });
    const cloudText = await cloudRes.text();
    res.json({ cloudinaryStatus: cloudRes.status, response: cloudText.substring(0, 300), svgLength: svg.length });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Health check (publico para que Railway/monitoring lo pingue)
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'trackin-shalom-worker',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    env: process.env.NODE_ENV || 'development'
  });
});

// ─────────────────────────────────────────────────────
// Endpoints autenticados
// ─────────────────────────────────────────────────────

// Test de credenciales Shalom (login + ping)
app.post('/test-credenciales', requireWorkerAuth, async (req, res) => {
  const { email = SHALOM_EMAIL, password = SHALOM_PASSWORD } = req.body || {};
  try {
    const client = new ShalomClient({ email, password, debug: DEBUG });
    await client.login();
    const sender = await client.searchPersonGlobal(REMITENTE_DOC, 'DNI');
    res.json({
      ok: true,
      message: 'Credenciales validas',
      remitente: sender.data
    });
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: e.message,
      code: e.code,
      details: e.details
    });
  }
});

// Listar terminales (cacheado)
app.get('/terminales', requireWorkerAuth, async (req, res) => {
  try {
    const client = new ShalomClient({ email: SHALOM_EMAIL, password: SHALOM_PASSWORD, debug: DEBUG });
    await client.ensureSession();
    const terminals = await client.listTerminals();
    res.json({ ok: true, total: terminals.length, terminals });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Buscar terminal por nombre
app.get('/terminales/buscar', requireWorkerAuth, async (req, res) => {
  const q = String(req.query.q || '').toUpperCase().trim();
  if (!q) return res.status(400).json({ error: 'Falta query ?q=' });
  try {
    const client = new ShalomClient({ email: SHALOM_EMAIL, password: SHALOM_PASSWORD, debug: DEBUG });
    await client.ensureSession();
    const terminals = await client.listTerminals();
    const matches = terminals.filter(t => JSON.stringify(t).toUpperCase().includes(q));
    res.json({ ok: true, total: matches.length, matches });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ⭐ Consultar modalidad + tarifa de una RUTA específica (para mostrar en TrackIn
// antes de crear el pedido). Dice si la ruta es AEREO o TERRESTRE según el propio servidor.
app.get('/consultar-ruta', requireWorkerAuth, async (req, res) => {
  const origenId = Number(req.query.origen) || parseInt(SHALOM_TERMINAL_ORIGEN);
  const destinoId = Number(req.query.destino);
  if (!destinoId || isNaN(destinoId)) {
    return res.status(400).json({ ok: false, error: 'Falta ?destino=<ter_id>' });
  }
  try {
    const client = new ShalomClient({ email: SHALOM_EMAIL, password: SHALOM_PASSWORD, debug: DEBUG });
    await client.ensureSession();
    const r = await client.apiCall('POST', '/mostrar-tarifa-origen-destino', {
      origen: origenId,
      destino: destinoId,
      peso: 0.5,
      largo: 0.20,
      ancho: 0.15,
      alto: 0.12,
      cantidad: 1
    });
    if (!r?.valor || !r?.data) {
      return res.status(200).json({ ok: false, error: 'Shalom no devolvio tarifa valida', raw: r });
    }
    const tarifa = parseFloat(r.data.tar_paquetexxs || r.data.tar_paqueteria || r.data.tar_minimopeso || 10);
    res.json({
      ok: true,
      origen: origenId,
      destino: destinoId,
      aereo: !!r.aereo,
      modalidad: r.aereo ? 'aereo' : 'terrestre',
      tarifa,
      tiempo_llegada: r.data.lead_time || (r.data.tar_tiempo_llegada ? r.data.tar_tiempo_llegada + ' horas' : null),
      distancia_km: r.data.distancia || null
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, code: e.code });
  }
});

// Buscar persona por DNI
app.get('/persona/:dni', requireWorkerAuth, async (req, res) => {
  try {
    const client = new ShalomClient({ email: SHALOM_EMAIL, password: SHALOM_PASSWORD, debug: DEBUG });
    await client.ensureSession();
    const persona = await client.searchPersonGlobal(req.params.dni, 'DNI');
    res.json({ ok: true, persona: persona.data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// SUBIR UN PEDIDO INDIVIDUAL A SHALOM
app.post('/subir-pedido', requireWorkerAuth, async (req, res) => {
  const { pedido, credentials } = req.body || {};
  if (!pedido) return res.status(400).json({ error: 'Falta { pedido } en el body' });
  // Validar estructura
  const valErr = validarPedido(pedido);
  if (valErr) return res.status(400).json({ ok: false, error: valErr, code: 'VALIDATION' });
  // Anti-duplicado: si este pedido ya esta en proceso, rechazar
  const lockKey = pedido.id || pedido.dni;
  if (_pedidosEnProceso.has(lockKey)) {
    return res.status(409).json({ ok: false, error: 'Este pedido ya esta siendo procesado (doble click?)', code: 'DUPLICATE' });
  }
  _pedidosEnProceso.add(lockKey);
  try {
    // Credenciales dinámicas del body o fallback a env vars
    const email = credentials?.email || SHALOM_EMAIL;
    const password = credentials?.password || SHALOM_PASSWORD;
    const remitenteDoc = credentials?.dni || REMITENTE_DOC;
    const result = await subirPedidoAShalom({
      pedido,
      credenciales: { email, password },
      remitenteData: { document: remitenteDoc },
      terminalOrigenId: SHALOM_TERMINAL_ORIGEN,
      debug: DEBUG
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: e.message,
      code: e.code,
      details: e.details
    });
  } finally {
    _pedidosEnProceso.delete(lockKey);
  }
});

// SUBIR UN BATCH DE PEDIDOS (los procesa secuencialmente reusando la sesion)
app.post('/subir-batch', requireWorkerAuth, async (req, res) => {
  const { pedidos, credentials } = req.body || {};
  if (!Array.isArray(pedidos) || pedidos.length === 0) {
    return res.status(400).json({ error: 'Falta { pedidos: [...] }' });
  }
  if (pedidos.length > 100) {
    return res.status(400).json({ error: 'Maximo 100 pedidos por batch' });
  }

  // Credenciales dinámicas del body o fallback a env vars
  const credenciales = { email: credentials?.email || SHALOM_EMAIL, password: credentials?.password || SHALOM_PASSWORD };
  const remitenteData = { document: credentials?.dni || REMITENTE_DOC };
  const resultados = [];
  let ok = 0, fail = 0;

  for (const pedido of pedidos) {
    try {
      const result = await subirPedidoAShalom({
        pedido,
        credenciales,
        remitenteData,
        terminalOrigenId: SHALOM_TERMINAL_ORIGEN,
        debug: DEBUG
      });
      resultados.push({
        pedidoId: pedido.id || null,
        ok: true,
        ose_id: result.ose_id,
        codigo: result.codigo,
        guia: result.raw?.data?.guia || null,
        serie: result.raw?.data?.serie || null,
        clave: result.clave || null,
        numeroShalom: result.raw?.data?.guia ? String(result.raw.data.guia) : null,
        destino: result.destino_terminal
      });
      ok++;
    } catch (e) {
      resultados.push({
        pedidoId: pedido.id || null,
        ok: false,
        error: e.message,
        code: e.code,
        details: e.details
      });
      fail++;
    }
  }

  res.json({
    ok: true,
    total: pedidos.length,
    exitosos: ok,
    fallidos: fail,
    resultados
  });
});

// Reset cache (util para debug)
app.post('/cache/reset', requireWorkerAuth, (req, res) => {
  clearShalomCache();
  res.json({ ok: true, message: 'Cache borrada' });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Server error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`╔══════════════════════════════════════════════╗`);
  console.log(`║  TrackIn-IA Shalom Worker                    ║`);
  console.log(`║  Listening on port ${PORT.toString().padEnd(5)}                     ║`);
  console.log(`║  Env: ${(process.env.NODE_ENV || 'development').padEnd(38)} ║`);
  console.log(`╚══════════════════════════════════════════════╝`);

  // Auto-ping para que Render no duerma el servicio (cada 13 minutos)
  setInterval(() => {
    fetch(`http://localhost:${PORT}/health`).catch(() => {});
  }, 13 * 60 * 1000);
});
