# TrackIn-IA Shalom Worker

Worker HTTP que registra envíos en `pro.shalom.pe` automáticamente desde TrackIn-IA.

## Cómo funciona

```
TrackIn-IA (Vercel) ──HTTPS──► Este Worker (Railway) ──HTTPS──► pro.shalom.pe
```

1. TrackIn-IA llama a `POST /subir-batch` con un array de pedidos
2. El worker se loguea en Shalom Pro (cookies + CSRF cacheados)
3. Por cada pedido: resuelve terminal de destino, calcula tarifa, registra envío
4. Devuelve `ose_id` + `código` por cada pedido procesado
5. TrackIn-IA actualiza Firestore con esos datos

## Endpoints

| Método | Path | Descripción |
|---|---|---|
| `GET` | `/health` | Health check (público) |
| `POST` | `/test-credenciales` | Verifica login a Shalom Pro |
| `GET` | `/terminales` | Lista todas las terminales (cacheado 10min) |
| `GET` | `/terminales/buscar?q=...` | Busca terminales por nombre |
| `GET` | `/persona/:dni` | Busca persona por DNI en Shalom |
| `POST` | `/subir-pedido` | Sube UN pedido a Shalom |
| `POST` | `/subir-batch` | Sube varios pedidos a Shalom |
| `POST` | `/cache/reset` | Limpia cache (debug) |

Todos los endpoints excepto `/health` requieren header `X-Worker-Key: <secret>`.

## Variables de entorno

```bash
PORT=3001                                  # puerto
WORKER_API_KEY=<secreto-compartido>        # auth entre Vercel y este worker
SHALOM_EMAIL=<email shalom pro>
SHALOM_PASSWORD=<password shalom pro>
SHALOM_TERMINAL_ORIGEN=426                 # ID terminal origen (Los Fresnos)
SHALOM_REMITENTE_DOC=74303615              # DNI del remitente fijo
NODE_ENV=production
DEBUG=0                                    # 1 para logs detallados
```

## Local

```bash
npm install
PORT=3001 WORKER_API_KEY=dev-secret node src/server.js
```

## Test rápido

```bash
# health
curl http://localhost:3001/health

# test credenciales
curl -X POST http://localhost:3001/test-credenciales \
  -H "X-Worker-Key: dev-secret" -H "Content-Type: application/json" -d '{}'

# subir un pedido
curl -X POST http://localhost:3001/subir-pedido \
  -H "X-Worker-Key: dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"pedido":{"id":"xxx","nombre":"...","dni":"73020359","provincia":"LA LIBERTAD","ciudad":"TRUJILLO",...}}'
```

## Estructura

```
src/
  server.js           # Express HTTP server
  shalom-client.js    # Cliente HTTP para pro.shalom.pe (login, cookies, retry)
  shipment-builder.js # Construye payload del POST /service_order/save
  shalom-service.js   # Orquesta el flujo (login → tarifa → save)
package.json
.gitignore
README.md
```

## Deploy en Railway

Configurado en `nixpacks.toml` (Node 20 + npm install + npm start).
