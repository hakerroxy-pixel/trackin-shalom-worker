// src/shipment-builder.js
// Construye el payload del POST /envia_ya/service_order/save EXACTO al que manda el SPA.
// CRITICO: remitente_id y destinatario_id deben ser IDs reales (devueltos por /envia_ya/person/save).
// Sin esos, la guia se crea pero queda HUERFANA (no aparece en /enviospendientes del user).

import { ShalomError } from './shalom-client.js';

// Default: Caja Paquete XS (id=1090, 15x20x12 cm, ~0.5kg)
// El SPA NO manda dimensiones cuando son defaults del producto — el server las llena.
const DEFAULT_PRODUCT = {
  id: 1090,
  title: 'Caja Paquete XS',
  detalle: '15 x 20 x 12'
};

export function buildServiceOrderPayload(pedido, ctx) {
  if (!ctx.terminalOrigenId) throw new ShalomError('Falta terminalOrigenId', 'NO_ORIGEN');
  if (!ctx.terminalDestinoId) throw new ShalomError('Falta terminalDestinoId', 'NO_DESTINO');
  if (!ctx.remitenteId) throw new ShalomError('Falta remitenteId (id interno Shalom)', 'NO_REM_ID');
  if (!ctx.destinatarioId) throw new ShalomError('Falta destinatarioId (id interno Shalom)', 'NO_DEST_ID');
  if (!pedido.dni) throw new ShalomError('Pedido sin DNI destinatario', 'NO_DNI');

  const product = ctx.productInfo || DEFAULT_PRODUCT;
  const tarifa = parseFloat(ctx.tarifa || pedido.costoEnvio || 8);
  const clave = ctx.claveSeguridad || generarClave();

  return {
    origen: Number(ctx.terminalOrigenId),
    destino: Number(ctx.terminalDestinoId),
    tipo_pago: ctx.tipoPago || 'DESTINATARIO',          // "REMITENTE" o "DESTINATARIO"
    tipo_producto: Number(product.id),
    tipo_producto_json: {
      value: tarifa,                                     // SPA lo manda como number
      name: product.title,
      detalle: product.detalle || ''
    },
    cantidad: 1,
    // Dimensiones vacias = el server usa las del producto
    peso: '',
    alto: '',
    largo: '',
    ancho: '',
    costo: tarifa,                                       // number, no string
    remitente: String(ctx.remitenteDocumento),
    destinatario: String(pedido.dni),
    remitente_id: Number(ctx.remitenteId),               // ⭐ CLAVE para no quedar huerfano
    destinatario_id: Number(ctx.destinatarioId),         // ⭐ CLAVE para no quedar huerfano
    garantia: 0,
    garantia_costo: 0,
    garantia_monto: '0.00',
    contacto_doc: '',
    grrs: '[]',
    clave: String(clave),
    aereo: ctx.aereo ? 1 : 0,
    servicio_cobranza: 0,
    servicio_cobranza_costo: 0,
    servicio_cobranza_datos: '{"document":"","name":"","bank":"","type_account":"","account_number":"","cci":"","cci":""}',
    declaracion_jurada: ctx.declaracionJurada || ''      // requerido si aereo=1, vacio si terrestre
  };
}

// Genera clave de 4 digitos no repetidos (Shalom rechaza 1111, 2222, etc.)
function generarClave() {
  while (true) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!/^(\d)\1{3}$/.test(c)) return c;
  }
}

export { DEFAULT_PRODUCT };
