// src/shalom-client.js
// Cliente HTTP para pro.shalom.pe — maneja login, cookies, CSRF, retries y refresh.
// Multi-tenant ready: cada instancia tiene su propio jar de cookies + credenciales.

const SHALOM_URL = 'https://pro.shalom.pe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ─────────────────────────────────────────────────────
// Helpers de cookies
// ─────────────────────────────────────────────────────
function parseSetCookie(setCookieArr) {
  const cookies = {};
  if (!setCookieArr) return cookies;
  for (const c of setCookieArr) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return cookies;
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function decodeCookieValue(v) {
  try { return decodeURIComponent(v); } catch (_) { return v; }
}

function extractCsrf(html) {
  const meta = html.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i);
  if (meta) return meta[1];
  const input = html.match(/<input[^>]*name=["']_token["'][^>]*value=["']([^"']+)["']/i)
             || html.match(/<input[^>]*value=["']([^"']+)["'][^>]*name=["']_token["']/i);
  return input ? input[1] : null;
}

// ─────────────────────────────────────────────────────
// Errores tipados
// ─────────────────────────────────────────────────────
export class ShalomError extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// ─────────────────────────────────────────────────────
// ShalomClient
// ─────────────────────────────────────────────────────
export class ShalomClient {
  constructor({ email, password, sessionStore = null, debug = false }) {
    if (!email || !password) {
      throw new ShalomError('Faltan credenciales (email/password)', 'NO_CREDS');
    }
    this.email = email;
    this.password = password;
    this.sessionStore = sessionStore; // opcional: { get(key), set(key, value) }
    this.debug = debug;
    this.jar = {};
    this.csrf = null;
    this.lastLogin = 0;
    this.SESSION_TTL_MS = 25 * 60 * 1000; // 25 minutos (Laravel default 120 min, jugamos seguro)
  }

  log(...args) {
    if (this.debug) console.log('[ShalomClient]', ...args);
  }

  isSessionFresh() {
    return this.jar.enviashalom_session && (Date.now() - this.lastLogin) < this.SESSION_TTL_MS;
  }

  async ensureSession() {
    // Reusar sesion si esta fresca
    if (this.isSessionFresh()) {
      this.log('Reusando sesion fresca');
      return;
    }
    // Intentar cargar de cache externo
    if (this.sessionStore) {
      const cached = await this.sessionStore.get(this.email);
      if (cached && (Date.now() - cached.lastLogin) < this.SESSION_TTL_MS) {
        this.jar = cached.jar;
        this.csrf = cached.csrf;
        this.lastLogin = cached.lastLogin;
        this.log('Sesion cargada del cache externo');
        return;
      }
    }
    // Login fresco
    await this.login();
  }

  async login() {
    this.log('Login iniciado');
    this.jar = {};

    // PASO 1: GET /login para obtener CSRF + cookies iniciales
    let res = await fetch(SHALOM_URL + '/login', {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-PE,es;q=0.9'
      },
      redirect: 'manual'
    });
    if (res.status !== 200) {
      throw new ShalomError(`GET /login fallo con status ${res.status}`, 'LOGIN_GET_FAIL');
    }
    Object.assign(this.jar, parseSetCookie(res.headers.getSetCookie()));
    const html = await res.text();
    const csrf = extractCsrf(html);
    if (!csrf) {
      throw new ShalomError('No se pudo extraer CSRF token de la pagina de login', 'NO_CSRF');
    }

    // PASO 2: POST /login con credenciales
    res = await fetch(SHALOM_URL + '/login', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieHeader(this.jar),
        'Referer': SHALOM_URL + '/login',
        'Origin': SHALOM_URL,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-PE,es;q=0.9',
        'X-XSRF-TOKEN': decodeCookieValue(this.jar['XSRF-TOKEN'] || '')
      },
      body: new URLSearchParams({
        _token: csrf,
        email: this.email,
        password: this.password
      }).toString(),
      redirect: 'manual'
    });
    Object.assign(this.jar, parseSetCookie(res.headers.getSetCookie()));

    if (res.status !== 302) {
      const body = await res.text();
      throw new ShalomError(
        `POST /login fallo con status ${res.status} (esperaba 302)`,
        'LOGIN_POST_FAIL',
        { status: res.status, bodyPreview: body.slice(0, 300) }
      );
    }

    // PASO 3: GET / para obtener el CSRF de la SPA
    res = await fetch(SHALOM_URL + '/', {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Cookie': cookieHeader(this.jar),
        'Accept': 'text/html'
      },
      redirect: 'manual'
    });
    Object.assign(this.jar, parseSetCookie(res.headers.getSetCookie()));
    if (res.status === 200) {
      const dashHtml = await res.text();
      const dashCsrf = extractCsrf(dashHtml);
      if (dashCsrf) this.csrf = dashCsrf;
    }
    if (!this.csrf) this.csrf = csrf; // fallback

    this.lastLogin = Date.now();
    this.log('Login exitoso. CSRF:', this.csrf?.slice(0, 16) + '...');

    // Guardar en cache externo
    if (this.sessionStore) {
      await this.sessionStore.set(this.email, {
        jar: { ...this.jar },
        csrf: this.csrf,
        lastLogin: this.lastLogin
      });
    }
  }

  // Llamada API generica con auto-relogin si la sesion expira
  async apiCall(method, path, body = null, opts = {}) {
    await this.ensureSession();

    const doCall = async () => {
      const headers = {
        'User-Agent': UA,
        'Cookie': cookieHeader(this.jar),
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'X-XSRF-TOKEN': decodeCookieValue(this.jar['XSRF-TOKEN'] || ''),
        'X-CSRF-TOKEN': this.csrf || '',
        'Referer': SHALOM_URL + '/',
        'Origin': SHALOM_URL,
        ...(opts.headers || {})
      };
      if (body !== null && body !== undefined) {
        headers['Content-Type'] = 'application/json;charset=UTF-8';
      }
      const res = await fetch(SHALOM_URL + path, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(30000) // 30s timeout para evitar hang forever
      });
      // Refresh cookies si vienen
      const sc = res.headers.getSetCookie();
      if (sc.length) Object.assign(this.jar, parseSetCookie(sc));
      return res;
    };

    let res = await doCall();

    // Si 401/419 (sesion expirada), re-loguear y reintentar UNA vez
    if (res.status === 401 || res.status === 419) {
      this.log('Sesion expirada (status ' + res.status + '), re-loguear...');
      await this.login();
      res = await doCall();
    }

    const ct = res.headers.get('content-type') || '';
    let data;
    if (ct.includes('application/json')) {
      try {
        data = await res.json();
      } catch (e) {
        throw new ShalomError(`JSON parse error en ${method} ${path}`, 'JSON_PARSE_ERR');
      }
    } else {
      const text = await res.text();
      // A veces Shalom devuelve text/html con JSON dentro
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new ShalomError(
          `Respuesta no-JSON en ${method} ${path} (${ct})`,
          'NOT_JSON',
          { status: res.status, contentType: ct, bodyPreview: text.slice(0, 200) }
        );
      }
    }

    if (res.status >= 400) {
      throw new ShalomError(
        `${method} ${path} fallo con status ${res.status}`,
        'API_ERROR',
        { status: res.status, body: data }
      );
    }

    return data;
  }

  // ───────────────────────────────────────────────────
  // Operaciones de alto nivel
  // ───────────────────────────────────────────────────

  async searchPersonGlobal(documento, tipoDoc = 'DNI') {
    return this.apiCall('POST', '/person/search', {
      type_document: tipoDoc,
      document: documento
    });
  }

  // Busca persona por DNI en el contexto envia_ya (devuelve datos RENIEC)
  // type debe ser 'sender' o 'receiver'
  async searchPersonEnviaYa(documento, type = 'receiver') {
    return this.apiCall('POST', '/envia_ya/person/search', {
      documento: String(documento),
      type
    });
  }

  // Crea/actualiza persona en envia_ya y DEVUELVE EL ID INTERNO (clave para no quedar huerfana)
  // Espera datos del search previo: name, lastname (paterno), surname (materno), phone
  async savePersonEnviaYa({ documento, name, firstname, lastname, phone }) {
    return this.apiCall('POST', '/envia_ya/person/save', {
      documento: String(documento),
      name: name || '',
      firstname: firstname || '',  // OJO: SPA pone el apellido paterno aqui
      lastname: lastname || '',    // OJO: SPA pone el apellido materno aqui
      phone: phone || 0
    });
  }

  // Helper: garantiza que la persona exista en la cuenta del user y devuelve su id
  // Si la persona ya existe, /person/save devuelve el id existente (es upsert)
  async ensurePersonId(documento, type = 'receiver') {
    if (!documento || String(documento).trim().length < 7) {
      throw new ShalomError(`DNI invalido: "${documento}"`, 'INVALID_DNI');
    }
    const docStr = String(documento).trim();
    let searchData = null;

    // Buscar en RENIEC via Shalom — si falla, intentar save directo (para DNIs que no están en RENIEC pero sí en Shalom)
    try {
      const search = await this.searchPersonEnviaYa(docStr, type);
      if (search?.success && search.data) {
        searchData = search.data;
      }
    } catch (e) {
      this.log('Search persona fallo, intentando save directo:', e.message);
    }

    // Si no encontró en RENIEC, intentar save con datos mínimos (Shalom acepta y devuelve ID si ya existe)
    const savePayload = searchData ? {
      documento: docStr,
      name: searchData.name || '',
      firstname: searchData.lastname || '',    // SPA: firstname = apellido paterno
      lastname: searchData.surname || '',       // SPA: lastname  = apellido materno
      phone: searchData.phone || 0
    } : {
      documento: docStr,
      name: 'CLIENTE',
      firstname: docStr,
      lastname: '',
      phone: 0
    };

    const save = await this.savePersonEnviaYa(savePayload);
    if (!save?.success || !save.data?.id || typeof save.data.id !== 'number') {
      throw new ShalomError(
        `No se pudo registrar persona DNI ${docStr}` + (save?.message ? ': ' + save.message : ''),
        'PERSON_SAVE_FAIL',
        save
      );
    }
    return {
      id: save.data.id,
      name: searchData?.name || savePayload.name,
      firstname: searchData?.lastname || '',
      lastname: searchData?.surname || '',
      full_name: searchData?.full_name || docStr,
      phone: searchData?.phone || 0,
      document: docStr
    };
  }

  async listTerminals() {
    const res = await this.apiCall('POST', '/envia_ya/terminals', {});
    // La respuesta puede venir como { Map: [...] } o directo array
    if (Array.isArray(res)) return res;
    if (res && Array.isArray(res.Map)) return res.Map;
    if (res && Array.isArray(res.data)) return res.data;
    if (res && res.success && Array.isArray(res.data?.Map)) return res.data.Map;
    return res;
  }

  async getRestriccionesCategorias() {
    return this.apiCall('GET', '/envia_ya/service_order/restricciones-categorias');
  }

  async countOrdenes() {
    return this.apiCall('POST', '/envia_ya/service_order/count', { converted: false, send: false });
  }

  // POST /envia_ya/person/save — crea/upserta destinatario
  async upsertPersonEnvia(persona) {
    return this.apiCall('POST', '/envia_ya/person/save', persona);
  }

  async searchPersonEnvia(documento, tipoDocId = 1) {
    return this.apiCall('POST', '/envia_ya/person/search', {
      type_document: tipoDocId,
      document: documento
    });
  }

  // POST /envia_ya/service_order/save — CREA EL ENVIO
  async saveServiceOrder(payload) {
    return this.apiCall('POST', '/envia_ya/service_order/save', payload);
  }

  // GET ruta aerea
  async validateAirports(originId, destId) {
    return this.apiCall(
      'GET',
      `/envia_ya/service_order/validate-equal-airports/${originId}/${destId}`
    );
  }
}
