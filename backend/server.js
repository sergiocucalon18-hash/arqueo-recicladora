import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import {
  fechaBogota,
  generarReporteCompras,
  leerComprasPorFecha,
  leerOpcionesReporte,
  resumirCompras,
  sincronizarCompras,
  sincronizarComprasRecientes,
  sincronizarComprasRango
} from './comprasService.js';

const app = express();
const port = Number(process.env.PORT || 4000);
const syncIntervalSeconds = Number(process.env.SYNC_INTERVAL_SECONDS || 60);
const syncBackfillDays = Number(process.env.SYNC_BACKFILL_DAYS || 30);
const syncIntervalBackfillDays = Number(process.env.SYNC_INTERVAL_BACKFILL_DAYS || 2);

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'arqueo-recicladora-api' });
});

app.get('/compras-hoy', async (_req, res, next) => {
  try {
    const resumen = await sincronizarCompras(fechaBogota());
    res.json(resumen);
  } catch (error) {
    next(error);
  }
});

app.get('/compras', async (req, res, next) => {
  try {
    const fecha = String(req.query.fecha || fechaBogota());
    const compras = await leerComprasPorFecha(fecha);
    res.json(resumirCompras(compras, fecha));
  } catch (error) {
    next(error);
  }
});

app.get('/compras-opciones', async (_req, res, next) => {
  try {
    res.json(await leerOpcionesReporte());
  } catch (error) {
    next(error);
  }
});

app.get('/reporte-compras', async (req, res, next) => {
  try {
    const reporte = await generarReporteCompras({
      desde: req.query.desde,
      hasta: req.query.hasta,
      material: req.query.material,
      jornada: req.query.jornada
    });
    res.json(reporte);
  } catch (error) {
    next(error);
  }
});

app.post('/sync-compras-hoy', async (_req, res, next) => {
  try {
    const resumen = await sincronizarCompras(fechaBogota());
    res.json(resumen);
  } catch (error) {
    next(error);
  }
});

app.post('/sync-compras-rango', async (req, res, next) => {
  try {
    const desde = req.query.desde || req.body?.desde;
    const hasta = req.query.hasta || req.body?.hasta;
    if (!desde) throw new Error('Debes enviar desde=YYYY-MM-DD.');
    const resultados = await sincronizarComprasRango(desde, hasta);
    res.json({ ok: true, fechas: resultados.map((item) => item.fecha), cantidadDias: resultados.length });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const message = errorMessage(error);
  console.error(message);
  res.status(500).json({
    ok: false,
    error: message
  });
});

function errorMessage(error) {
  if (error?.errors?.length) {
    return error.errors.map((entry) => entry.message || String(entry)).join(' | ');
  }

  if (error?.message) return error.message;

  if (error?.code === 'ECONNREFUSED') {
    return 'MySQL rechazo la conexion. Revisa MYSQL_HOST, MYSQL_PORT y que el servicio MySQL este encendido.';
  }

  return 'Error interno del servidor';
}

const server = app.listen(port, () => {
  console.log(`API REST escuchando en http://localhost:${port}`);
  console.log(`Endpoint principal: http://localhost:${port}/compras-hoy`);

  sincronizarComprasRecientes(syncBackfillDays)
    .then((resultados) => logSyncSuccess('Sincronizacion inicial', resultados))
    .catch((error) => {
      console.error('No se pudo hacer la sincronizacion inicial de dias recientes:', errorMessage(error));
    });

  if (syncIntervalSeconds > 0) {
    setInterval(() => {
      sincronizarComprasRecientes(syncIntervalBackfillDays)
        .then((resultados) => logSyncSuccess('Sincronizacion periodica', resultados))
        .catch((error) => {
          console.error('No se pudo sincronizar compras:', errorMessage(error));
        });
    }, syncIntervalSeconds * 1000);
  }
});

function logSyncSuccess(label, resultados = []) {
  const lista = Array.isArray(resultados) ? resultados : [resultados];
  const last = lista.filter(Boolean).at(-1);
  const latestTime = latestPurchaseTime(last?.compras || []);
  const stamp = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  const detail = last
    ? `${lista.length} dia(s), ${last.fecha}, ${last.cantidadRegistros} compras${latestTime ? `, ultima ${latestTime}` : ''}`
    : 'sin compras en el rango';

  console.log(`[${stamp}] ${label}: ${detail}.`);
}

function latestPurchaseTime(compras = []) {
  return compras
    .map((compra) => compra.hora_registro_salida)
    .filter(Boolean)
    .sort()
    .at(-1) || '';
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`El puerto ${port} ya esta en uso. Cierra el servidor anterior o cambia PORT en .env.`);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});
