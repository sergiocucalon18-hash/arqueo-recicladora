import { firestore } from './firebaseAdmin.js';
import { pool } from './mysql.js';

const comprasCollection = 'compras_diarias';

export function fechaBogota(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

export async function leerComprasPorFecha(fecha = fechaBogota()) {
  const [rows] = await pool.execute(
    `SELECT
       fecha,
       material,
       peso_neto_kg,
       subtotal,
       hora_registro_salida,
       jornada
     FROM tbl_consolidado_compras
     WHERE DATE(fecha) = ?
     ORDER BY hora_registro_salida ASC, material ASC`,
    [fecha]
  );

  return rows.map((row, index) => normalizarCompra(row, index));
}

export function resumirCompras(compras, fecha = fechaBogota()) {
  const totalDiario = roundMoney(compras.reduce((sum, compra) => sum + Number(compra.subtotal || 0), 0));
  const totalPesoKg = roundWeight(compras.reduce((sum, compra) => sum + Number(compra.peso_neto_kg || 0), 0));
  const porJornada = compras.reduce((acc, compra) => {
    const jornada = compra.jornada || 'Sin jornada';
    const current = acc[jornada] || { jornada, totalSubtotal: 0, totalPesoKg: 0, cantidadRegistros: 0 };
    current.totalSubtotal = roundMoney(current.totalSubtotal + Number(compra.subtotal || 0));
    current.totalPesoKg = roundWeight(current.totalPesoKg + Number(compra.peso_neto_kg || 0));
    current.cantidadRegistros += 1;
    acc[jornada] = current;
    return acc;
  }, {});

  return {
    fecha,
    totalDiario,
    totalPesoKg,
    cantidadRegistros: compras.length,
    porJornada,
    compras,
    actualizadoEn: new Date().toISOString()
  };
}

export async function sincronizarCompras(fecha = fechaBogota()) {
  const compras = await leerComprasPorFecha(fecha);
  const resumen = resumirCompras(compras, fecha);
  const opciones = await leerOpcionesReporte();

  await firestore.collection(comprasCollection).doc(fecha).set({
    ...resumen,
    opciones,
    opcionesActualizadoEn: new Date().toISOString()
  }, { merge: true });

  return resumen;
}

export async function leerOpcionesReporte() {
  const [materials] = await pool.execute(
    `SELECT DISTINCT material
     FROM tbl_consolidado_compras
     WHERE material IS NOT NULL AND TRIM(material) <> ''
     ORDER BY material ASC`
  );
  const [journals] = await pool.execute(
    `SELECT DISTINCT jornada
     FROM tbl_consolidado_compras
     WHERE UPPER(TRIM(jornada)) IN ('DIURNA', 'NOCTURNA')
     ORDER BY jornada ASC`
  );

  return {
    materiales: materials.map((row) => cleanText(row.material)).filter(Boolean),
    jornadas: journals.map((row) => cleanText(row.jornada)).filter(Boolean)
  };
}

export async function generarReporteCompras(filters = {}) {
  const desde = normalizeDateTime(filters.desde);
  const hasta = normalizeDateTime(filters.hasta);
  const material = cleanText(filters.material);
  const jornada = cleanText(filters.jornada);

  if (!desde || !hasta) {
    throw new Error('Debes enviar desde y hasta con formato YYYY-MM-DDTHH:mm o YYYY-MM-DD HH:mm:ss.');
  }

  const params = [desde, hasta];
  const where = [`${purchaseTimestampExpression()} BETWEEN ? AND ?`];

  if (material) {
    where.push('UPPER(TRIM(material)) = UPPER(TRIM(?))');
    params.push(material);
  }

  if (jornada) {
    where.push('UPPER(TRIM(jornada)) = UPPER(TRIM(?))');
    params.push(jornada);
  }

  const [rows] = await pool.execute(
    `SELECT
       fecha,
       material,
       peso_neto_kg,
       subtotal,
       hora_registro_salida,
       jornada
     FROM tbl_consolidado_compras
     WHERE ${where.join(' AND ')}
     ORDER BY fecha ASC, hora_registro_salida ASC, material ASC`,
    params
  );

  const compras = rows.map((row, index) => normalizarCompra(row, index));
  return resumirReporte(compras, { desde, hasta, material, jornada });
}

function resumirReporte(compras, filters) {
  const totalSubtotal = roundMoney(compras.reduce((sum, compra) => sum + Number(compra.subtotal || 0), 0));
  const totalPesoKg = roundWeight(compras.reduce((sum, compra) => sum + Number(compra.peso_neto_kg || 0), 0));
  const porMaterial = groupTotals(compras, 'material');
  const porJornada = groupTotals(compras, 'jornada');
  const porMaterialJornada = compras.reduce((acc, compra) => {
    const key = `${compra.material || 'Sin material'} / ${compra.jornada || 'Sin jornada'}`;
    const current = acc[key] || {
      material: compra.material || 'Sin material',
      jornada: compra.jornada || 'Sin jornada',
      totalSubtotal: 0,
      totalPesoKg: 0,
      cantidadRegistros: 0
    };
    current.totalSubtotal = roundMoney(current.totalSubtotal + Number(compra.subtotal || 0));
    current.totalPesoKg = roundWeight(current.totalPesoKg + Number(compra.peso_neto_kg || 0));
    current.cantidadRegistros += 1;
    acc[key] = current;
    return acc;
  }, {});

  return {
    filtros: filters,
    totalSubtotal,
    totalPesoKg,
    cantidadRegistros: compras.length,
    porMaterial,
    porJornada,
    porMaterialJornada,
    compras,
    generadoEn: new Date().toISOString()
  };
}

function groupTotals(compras, field) {
  return compras.reduce((acc, compra) => {
    const key = compra[field] || `Sin ${field}`;
    const current = acc[key] || { nombre: key, totalSubtotal: 0, totalPesoKg: 0, cantidadRegistros: 0 };
    current.totalSubtotal = roundMoney(current.totalSubtotal + Number(compra.subtotal || 0));
    current.totalPesoKg = roundWeight(current.totalPesoKg + Number(compra.peso_neto_kg || 0));
    current.cantidadRegistros += 1;
    acc[key] = current;
    return acc;
  }, {});
}

function purchaseTimestampExpression() {
  return "CAST(CONCAT(DATE(fecha), ' ', TIME(hora_registro_salida)) AS DATETIME)";
}

function normalizeDateTime(value) {
  if (!value) return '';
  const text = String(value).trim().replace('T', ' ');
  return text.length === 16 ? `${text}:00` : text;
}

function normalizarCompra(row, index) {
  const fecha = toDateOnly(row.fecha);
  const hora = toTimeOnly(row.hora_registro_salida);
  const material = cleanText(row.material);
  const jornada = cleanText(row.jornada);

  return {
    id: stableId([fecha, hora, material, jornada, index]),
    fecha,
    material,
    peso_neto_kg: Number(row.peso_neto_kg || 0),
    subtotal: Number(row.subtotal || 0),
    hora_registro_salida: hora,
    jornada
  };
}

function toDateOnly(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function toTimeOnly(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(11, 19) || value.slice(0, 8);
  return new Date(value).toTimeString().slice(0, 8);
}

function cleanText(value) {
  return String(value || '').trim();
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function roundWeight(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function stableId(parts) {
  return parts.join('|').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
