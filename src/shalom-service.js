// src/shalom-service.js
// Servicio de alto nivel: orquesta el flujo completo de subir un pedido a Shalom Pro.
// Recibe un pedido de TrackIn-IA y devuelve { ose_id, codigo, ... } o un error tipado.

import { ShalomClient, ShalomError } from './shalom-client.js';
import { buildServiceOrderPayload, DEFAULT_PRODUCT } from './shipment-builder.js';

// 📸 Generar imagen de boleta con los datos de la guía y subir a Cloudinary
async function capturarBoleta(oseId, credenciales, guiaData) {
  try {
    // Generar SVG con los datos de la guía
    const nombre = guiaData?.nombre || '';
    const dni = guiaData?.dni || '';
    const destino = guiaData?.destino || '';
    const guia = guiaData?.guia || '';
    const codigo = guiaData?.codigo || '';
    const clave = guiaData?.clave || '';
    const modalidad = guiaData?.modalidad || 'TERRESTRE';
    
    console.log('[Shalom] Generando boleta SVG:', { nombre, dni, guia, codigo, clave, destino, modalidad, oseId });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="500" viewBox="0 0 420 500">
      <rect width="420" height="500" fill="white" rx="12"/>
      <rect width="420" height="60" fill="#DC2626" rx="12 12 0 0"/>
      <text x="20" y="38" font-family="Arial" font-size="22" font-weight="bold" fill="white">SHALOM</text>
      <text x="300" y="38" font-family="Arial" font-size="12" font-weight="bold" fill="rgba(255,255,255,0.8)">${modalidad.toUpperCase()}</text>
      <text x="20" y="100" font-family="Arial" font-size="11" fill="#94a3b8" font-weight="bold">N DE ORDEN</text>
      <text x="20" y="130" font-family="Courier" font-size="28" font-weight="bold" fill="#DC2626">${guia}</text>
      <text x="300" y="100" font-family="Arial" font-size="11" fill="#94a3b8" font-weight="bold">CÓDIGO</text>
      <text x="300" y="130" font-family="Courier" font-size="22" font-weight="bold" fill="#1e293b">${codigo}</text>
      <line x1="20" y1="150" x2="400" y2="150" stroke="#e2e8f0" stroke-width="2" stroke-dasharray="5,5"/>
      <text x="20" y="180" font-family="Arial" font-size="11" fill="#94a3b8" font-weight="bold">DESTINATARIO</text>
      <text x="20" y="200" font-family="Arial" font-size="14" font-weight="bold" fill="#1e293b">${nombre}</text>
      <text x="20" y="230" font-family="Arial" font-size="11" fill="#94a3b8" font-weight="bold">DNI</text>
      <text x="20" y="250" font-family="Courier" font-size="14" font-weight="bold" fill="#1e293b">${dni}</text>
      <text x="200" y="230" font-family="Arial" font-size="11" fill="#94a3b8" font-weight="bold">OSE ID</text>
      <text x="200" y="250" font-family="Courier" font-size="14" fill="#1e293b">${oseId}</text>
      <text x="20" y="290" font-family="Arial" font-size="11" fill="#94a3b8" font-weight="bold">DESTINO</text>
      <text x="20" y="310" font-family="Arial" font-size="14" font-weight="bold" fill="#1e293b">${destino}</text>
      <text x="20" y="345" font-family="Arial" font-size="11" fill="#94a3b8" font-weight="bold">ENTREGA</text>
      <rect x="20" y="355" width="90" height="24" rx="12" fill="#dbeafe"/>
      <text x="35" y="372" font-family="Arial" font-size="11" font-weight="bold" fill="#2563eb">En agencia</text>
      <rect x="20" y="400" width="380" height="70" rx="10" fill="#fef2f2" stroke="#DC2626" stroke-width="2"/>
      <text x="210" y="425" font-family="Arial" font-size="11" font-weight="bold" fill="#DC2626" text-anchor="middle">CLAVE DE RETIRO</text>
      <text x="210" y="455" font-family="Courier" font-size="32" font-weight="bold" fill="#DC2626" text-anchor="middle" letter-spacing="4">${clave}</text>
      <text x="210" y="490" font-family="Arial" font-size="9" fill="#94a3b8" text-anchor="middle">Generado por TrackIn-IA - pro.shalom.pe</text>
    </svg>`;

    // Convertir SVG a base64 y subir a Cloudinary
    const svgBase64 = Buffer.from(svg).toString('base64');
    const cloudName = process.env.CLOUDINARY_CLOUD || 'dnfgsdxan';
    const uploadPreset = process.env.CLOUDINARY_PRESET || 'EMPRESA';
    const formData = new URLSearchParams();
    formData.append('file', 'data:image/svg+xml;base64,' + svgBase64);
    formData.append('upload_preset', uploadPreset);
    formData.append('folder', 'boletas');
    const cloudRes = await fetch('https://api.cloudinary.com/v1_1/' + cloudName + '/image/upload', {
      method: 'POST',
      body: formData
    });
    if (cloudRes.ok) {
      const cloudData = await cloudRes.json();
      console.log('[Shalom] ✅ Boleta generada y subida:', cloudData.secure_url);
      return cloudData.secure_url;
    }
    const errText = await cloudRes.text();
    console.warn('[Shalom] Cloudinary upload failed:', cloudRes.status, errText.substring(0, 200));
    return null;
  } catch (e) {
    console.warn('[Shalom] capturarBoleta error:', e.message);
    return null;
  }
}

// Cache global de instancias de ShalomClient por email (para reusar sesiones en memoria del worker)
const clientCache = new Map();

function getClient({ email, password, debug = false }) {
  const key = email.toLowerCase();
  if (clientCache.has(key)) {
    const c = clientCache.get(key);
    // Si la password cambio, invalidar
    if (c.password !== password) {
      clientCache.delete(key);
    } else {
      return c;
    }
  }
  const c = new ShalomClient({ email, password, debug });
  clientCache.set(key, c);
  return c;
}

// Cache de terminales (10 min) para evitar pedirlas siempre
const terminalsCache = { data: null, ts: 0, ttl: 10 * 60 * 1000 };

async function getTerminalsCached(client) {
  if (terminalsCache.data && (Date.now() - terminalsCache.ts) < terminalsCache.ttl) {
    return terminalsCache.data;
  }
  const data = await client.listTerminals();
  terminalsCache.data = data;
  terminalsCache.ts = Date.now();
  return data;
}

// Resolver una terminal de destino segun los datos del pedido
// Estrategia: matching por nombre/zona/provincia/distrito (fuzzy)
function resolveDestinoTerminal(terminals, pedido) {
  const norm = (s) => String(s || '').toUpperCase().trim().replace(/\s+/g, ' ');
  const provincia = norm(pedido.provincia);
  const ciudad = norm(pedido.ciudad);

  // 1) Match exacto por zona === ciudad o zona === provincia
  for (const t of terminals) {
    if (t.destino !== 1) continue; // solo destinos validos
    const zona = norm(t.zona);
    if (zona && (zona === ciudad || zona === provincia)) return t;
  }
  // 2) Match exacto por provincia
  for (const t of terminals) {
    if (t.destino !== 1) continue;
    if (norm(t.provincia) === provincia && norm(t.zona) === ciudad) return t;
  }
  // 3) Match por contains
  for (const t of terminals) {
    if (t.destino !== 1) continue;
    const zona = norm(t.zona);
    if (zona && (zona.includes(ciudad) || ciudad.includes(zona))) return t;
  }
  // 4) Match por provincia solo
  for (const t of terminals) {
    if (t.destino !== 1) continue;
    if (norm(t.provincia) === provincia) return t;
  }
  return null;
}

// Calcular tarifa Los Fresnos -> destino (CON REFUERZOS)
// IMPORTANTE: dimensiones en METROS, peso en KG
// CORREGIDO: ahora devuelve { tarifa, aereo, strict } — el flag 'aereo' viene de la respuesta
// REAL de tarifa de la RUTA específica.
// REFUERZO: reintenta hasta 3 veces. Si los 3 intentos fallan, devuelve strict=false para que
// el caller DECIDA si quiere abortar o seguir. Nunca asume aereo=true silenciosamente.
async function calcularTarifa(client, origenId, destinoId, product) {
  const payload = {
    origen: origenId,
    destino: destinoId,
    peso: product.weight || 0.5,
    largo: product.length || 0.20,
    ancho: product.width || 0.15,
    alto: product.height || 0.12,
    cantidad: 1
  };

  const MAX_RETRIES = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await client.apiCall('POST', '/mostrar-tarifa-origen-destino', payload);
      if (r.valor && r.data) {
        const tarifa = parseFloat(r.data.tar_paquetexxs || r.data.tar_paqueteria || r.data.tar_minimopeso || 10);
        // ⭐ Respuesta oficial del servidor — confiable
        return {
          tarifa,
          aereo: !!r.aereo,
          tiempo_llegada: r.data.lead_time || r.data.tar_tiempo_llegada || null,
          strict: true,     // ← confirmado por el servidor
          attempt,
          rawAereo: r.aereo
        };
      }
      lastError = new Error('Shalom devolvio valor:false o sin data');
    } catch (e) {
      lastError = e;
      console.warn(`[shalom-service] calcularTarifa intento ${attempt}/${MAX_RETRIES} fallo:`, e.message);
      // Esperar 500ms * attempt antes del siguiente intento (backoff exponencial light)
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  // Los 3 intentos fallaron — devolver default INSEGURO con flag strict=false
  // para que el caller aborte si necesita certeza
  console.error('[shalom-service] calcularTarifa fallo despues de', MAX_RETRIES, 'intentos:', lastError?.message);
  return {
    tarifa: 10,
    aereo: false,       // ← default TERRESTRE (la opción segura si no sabemos)
    tiempo_llegada: null,
    strict: false,      // ← marca que este resultado NO es confiable
    error: lastError?.message || 'unknown'
  };
}

// FUNCION PRINCIPAL: subir un pedido a Shalom Pro
export async function subirPedidoAShalom({ pedido, credenciales, remitenteData, terminalOrigenId = 426, debug = false }) {
  const client = getClient({ ...credenciales, debug });
  await client.ensureSession();

  // ⭐ ORIGEN: si el pedido trae un id explicito, lo usamos. Si no, fallback al param/env default
  const origenIdFinal = pedido.shalomTerminalOrigenId || terminalOrigenId;

  // 1. Resolver destino — PRIORIDAD: ter_id explicito del frontend (cuando el user eligio en el selector)
  // Si no viene, fallback al fuzzy matching (para pedidos viejos sin shalomTerminalDestinoId)
  let destinoTerminal;
  const terminals = await getTerminalsCached(client);
  if (pedido.shalomTerminalDestinoId) {
    const idNum = Number(pedido.shalomTerminalDestinoId);
    if (isNaN(idNum)) {
      throw new ShalomError(`Terminal destino ID invalido: "${pedido.shalomTerminalDestinoId}"`, 'TERMINAL_ID_NAN');
    }
    destinoTerminal = terminals.find(t => Number(t.ter_id) === idNum);
    if (!destinoTerminal) {
      throw new ShalomError(
        `Terminal destino con id ${idNum} no encontrado en lista de Shalom (${terminals.length} terminales disponibles)`,
        'TERMINAL_ID_INVALIDO'
      );
    }
    if (debug) console.log('[Shalom] Destino EXPLICITO ter_id=' + idNum + ':', destinoTerminal.nombre || destinoTerminal.zona);
  } else {
    destinoTerminal = resolveDestinoTerminal(terminals, pedido);
    if (!destinoTerminal) {
      throw new ShalomError(
        `No se encontro terminal Shalom para destino: ${pedido.provincia} / ${pedido.ciudad}`,
        'DESTINO_NO_ENCONTRADO'
      );
    }
    if (debug) console.log('[Shalom] Destino FUZZY:', destinoTerminal.nombre, '(ter_id:', destinoTerminal.ter_id + ')');
  }

  // 2. Garantizar que el REMITENTE existe en la cuenta y obtener su id interno (CRITICO)
  const remitenteDoc = remitenteData?.document || credenciales.remitenteDoc || '74303615';
  const remitentePerson = await client.ensurePersonId(remitenteDoc, 'sender');
  if (debug) console.log('[Shalom] Remitente id:', remitentePerson.id, '(' + remitentePerson.full_name + ')');

  // 3. Garantizar que el DESTINATARIO existe en la cuenta y obtener su id interno (CRITICO)
  const destinatarioPerson = await client.ensurePersonId(pedido.dni, 'receiver');
  if (debug) console.log('[Shalom] Destinatario id:', destinatarioPerson.id, '(' + destinatarioPerson.full_name + ')');

  // 4. Producto: usar default Caja Paquete XS
  const productInfo = DEFAULT_PRODUCT;

  // 5. Calcular tarifa — AHORA devuelve { tarifa, aereo, tiempo_llegada, strict }
  const tarifaResult = await calcularTarifa(client, origenIdFinal, destinoTerminal.ter_id, productInfo);
  const tarifa = tarifaResult.tarifa;
  const esAereo = tarifaResult.aereo; // ⭐ flag REAL de la ruta (no de la terminal)

  // 🛡️ REFUERZO 1: si la consulta de tarifa NO fue confiable (fallaron los 3 intentos),
  // Continuar con terrestre por defecto y avisar (antes abortaba)
  if (!tarifaResult.strict) {
    console.warn('[shalom-service] ⚠️ Tarifa no confiable, usando TERRESTRE por defecto. Error:', tarifaResult.error);
  }

  // 🛡️ REFUERZO 2: cross-check contra ter_aereo de la terminal
  // Si la terminal dice aereo=0 PERO la tarifa dice aereo=true, hay inconsistencia grave
  // (esto nunca deberia pasar, pero si pasa, aborta).
  if (esAereo && destinoTerminal.ter_aereo === 0) {
    throw new ShalomError(
      'Inconsistencia: la ruta indica AEREO pero la terminal destino no soporta aereo. ' +
      'Terminal: ' + destinoTerminal.nombre + ' (ter_id=' + destinoTerminal.ter_id + ')',
      'INCONSISTENCY_AEREO_TERMINAL'
    );
  }

  if (debug) console.log('[Shalom] ✅ Tarifa verificada: S/', tarifa, '| Modalidad:', esAereo ? 'AEREO' : 'TERRESTRE', '| strict:', tarifaResult.strict, '| tiempo:', tarifaResult.tiempo_llegada);

  // 6. Construir payload (con remitente_id y destinatario_id REALES)
  const payload = buildServiceOrderPayload(pedido, {
    terminalOrigenId: origenIdFinal,
    terminalDestinoId: destinoTerminal.ter_id,
    remitenteDocumento: remitenteDoc,
    remitenteId: remitentePerson.id,
    destinatarioId: destinatarioPerson.id,
    tarifa,
    productInfo,
    aereo: esAereo,                                // ⭐ FIX: usa el flag real de la ruta
    tipoPago: 'DESTINATARIO',
    declaracionJurada: esAereo ? 'Documentos' : '' // solo si realmente es aéreo
  });

  if (debug) {
    console.log('[Shalom] Payload final:');
    console.log(JSON.stringify(payload, null, 2));
  }

  // 6. POST /service_order/save
  const res = await client.saveServiceOrder(payload);

  if (!res || res.success === false) {
    throw new ShalomError(
      'Shalom rechazo el envio: ' + (res?.message || 'error desconocido'),
      'SAVE_FAIL',
      res
    );
  }

  // 🛡️ REFUERZO 4: post-creación verificar con el API público de tracking
  // (este endpoint no requiere auth, entonces podemos usar fetch normal)
  let modalidadServer = null;
  let verificacionServer = false;
  const guiaNum = res.data?.guia ? String(res.data.guia) : null;
  const codigoGuia = res.data?.codigo || '';
  if (guiaNum) {
    try {
      const trackRes = await fetch(`https://serviceswebapi.shalomcontrol.com/api/v1/web/rastrea/buscar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `numero=${encodeURIComponent(guiaNum)}&codigo=${encodeURIComponent(codigoGuia)}&ose_id=`
      });
      if (trackRes.ok) {
        const trackData = await trackRes.json();
        if (trackData?.success && trackData.data) {
          modalidadServer = trackData.data.aereo === true ? 'aereo' : 'terrestre';
          verificacionServer = modalidadServer === (esAereo ? 'aereo' : 'terrestre');
          if (debug) console.log('[Shalom] ✅ Post-check server:', modalidadServer, '(match:', verificacionServer, ')');
        }
      }
    } catch (e) {
      console.warn('[shalom-service] post-check tracking fallo:', e.message);
    }
  }

  // 🛡️ REFUERZO 3: audit log SIEMPRE — deja traza de qué modalidad se envió
  console.log(JSON.stringify({
    audit: 'shalom_guia_creada',
    pedidoId: pedido.id,
    dni: pedido.dni,
    destino: destinoTerminal.nombre,
    destinoId: destinoTerminal.ter_id,
    origenId: origenIdFinal,
    modalidad_enviada: esAereo ? 'aereo' : 'terrestre',
    modalidad_server: modalidadServer,
    verificacion_server_ok: verificacionServer,
    modalidad_strict: tarifaResult.strict,
    tarifa,
    tiempo_llegada: tarifaResult.tiempo_llegada,
    guia: res.data?.guia || null,
    codigo: res.data?.codigo || null,
    ose_id: res.data?.ose_id || null,
    ter_aereo_terminal: destinoTerminal.ter_aereo,
    timestamp: new Date().toISOString()
  }));

  // 📸 Generar boleta SVG inline y subir a Cloudinary
  const oseId = res.data?.ose_id || res.ose_id || null;
  let boletaUrl = null;
  if (oseId) {
    try {
      const _bn = pedido.nombre || '';
      const _bd = pedido.dni || '';
      const _bg = res.data?.guia ? String(res.data.guia) : '';
      const _bc = res.data?.codigo || '';
      const _bk = payload.clave || '';
      const _bm = esAereo ? 'AEREO' : 'TERRESTRE';
      const _bt = destinoTerminal?.nombre || pedido.provincia || '';
      const _svg = '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="500" viewBox="0 0 420 500"><rect width="420" height="500" fill="white" rx="12"/><rect width="420" height="60" fill="#DC2626" rx="12 12 0 0"/><text x="20" y="38" font-family="Arial" font-size="22" font-weight="bold" fill="white">SHALOM</text><text x="300" y="38" font-family="Arial" font-size="12" font-weight="bold" fill="rgba(255,255,255,0.8)">' + _bm + '</text><text x="20" y="100" font-family="Arial" font-size="11" fill="#94a3b8" font-weight="bold">N DE ORDEN</text><text x="20" y="130" font-family="Courier" font-size="28" font-weight="bold" fill="#DC2626">' + _bg + '</text><text x="300" y="100" font-family="Arial" font-size="11" fill="#94a3b8" font-weight="bold">CODIGO</text><text x="300" y="130" font-family="Courier" font-size="22" font-weight="bold" fill="#1e293b">' + _bc + '</text><line x1="20" y1="150" x2="400" y2="150" stroke="#e2e8f0" stroke-width="2" stroke-dasharray="5,5"/><text x="20" y="180" font-family="Arial" font-size="11" fill="#94a3b8" font-weight="bold">DESTINATARIO</text><text x="20" y="200" font-family="Arial" font-size="14" font-weight="bold" fill="#1e293b">' + _bn + '</text><text x="20" y="230" font-family="Arial" font-size="11" fill="#94a3b8" font-weight="bold">DNI</text><text x="20" y="250" font-family="Courier" font-size="14" font-weight="bold" fill="#1e293b">' + _bd + '</text><text x="20" y="290" font-family="Arial" font-size="11" fill="#94a3b8" font-weight="bold">DESTINO</text><text x="20" y="310" font-family="Arial" font-size="14" font-weight="bold" fill="#1e293b">' + _bt + '</text><rect x="20" y="400" width="380" height="70" rx="10" fill="#fef2f2" stroke="#DC2626" stroke-width="2"/><text x="210" y="425" font-family="Arial" font-size="11" font-weight="bold" fill="#DC2626" text-anchor="middle">CLAVE DE RETIRO</text><text x="210" y="455" font-family="Courier" font-size="32" font-weight="bold" fill="#DC2626" text-anchor="middle" letter-spacing="4">' + _bk + '</text></svg>';
      const _b64 = Buffer.from(_svg).toString('base64');
      const _cn = process.env.CLOUDINARY_CLOUD || 'dnfgsdxan';
      const _cp = process.env.CLOUDINARY_PRESET || 'EMPRESA';
      const _fd = new URLSearchParams();
      _fd.append('file', 'data:image/svg+xml;base64,' + _b64);
      _fd.append('upload_preset', _cp);
      _fd.append('folder', 'boletas');
      const _cr = await fetch('https://api.cloudinary.com/v1_1/' + _cn + '/image/upload', { method: 'POST', body: _fd });
      if (_cr.ok) {
        const _cd = await _cr.json();
        boletaUrl = _cd.secure_url || null;
        console.log('[Shalom] Boleta subida:', boletaUrl);
      } else {
        console.warn('[Shalom] Cloudinary failed:', _cr.status);
      }
    } catch (e) {
      console.error('[Shalom] Boleta error:', e.message);
    }
  }

  return {
    ok: true,
    raw: res,
    ose_id: oseId,
    codigo: res.data?.codigo || res.codigo || null,
    guia: res.data?.guia || null,
    serie: res.data?.serie || null,
    clave: payload.clave || null,
    numeroShalom: res.data?.guia ? String(res.data.guia) : null,
    modalidad: esAereo ? 'aereo' : 'terrestre',
    modalidad_verificada: tarifaResult.strict && verificacionServer,
    modalidad_server: modalidadServer,
    tiempoLlegada: tarifaResult.tiempo_llegada,
    tarifa_calculada: tarifa,
    payload_enviado: payload,
    destino_terminal: destinoTerminal.nombre,
    boletaUrl                                        // ⭐ URL de la boleta como imagen
  };
}

// Limpiar cache periodicamente para evitar memory leaks (cada 30 min)
setInterval(() => {
  if (clientCache.size > 10) {
    clientCache.clear();
    console.log('[Shalom] clientCache limpiado (tenia ' + clientCache.size + ' entries)');
  }
  if (terminalsCache.ts && (Date.now() - terminalsCache.ts) > 30 * 60 * 1000) {
    terminalsCache.data = null;
    terminalsCache.ts = 0;
  }
}, 30 * 60 * 1000);

// Helper para clear cache (util en tests)
export function clearShalomCache() {
  clientCache.clear();
  terminalsCache.data = null;
  terminalsCache.ts = 0;
}

// Export for testing
export async function capturarBoletaTest(oseId) {
  return capturarBoleta(oseId, {}, {
    nombre: 'TEST BOLETA',
    dni: '74303615',
    destino: 'TRUJILLO',
    guia: oseId,
    codigo: 'TEST',
    clave: '1234',
    modalidad: 'TERRESTRE'
  });
}
