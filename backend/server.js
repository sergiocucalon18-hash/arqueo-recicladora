import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import {
  fechaBogota,
  generarReporteCompras,
  leerComprasPorFecha,
  leerOpcionesReporte,
  resumirCompras,
  sincronizarCompras
} from './comprasService.js';

const app = express();
const port = Number(process.env.PORT || 4000);
const syncIntervalSeconds = Number(process.env.SYNC_INTERVAL_SECONDS || 60);

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

  sincronizarCompras(fechaBogota()).catch((error) => {
    console.error('No se pudo hacer la sincronizacion inicial:', errorMessage(error));
  });

  if (syncIntervalSeconds > 0) {
    setInterval(() => {
      sincronizarCompras(fechaBogota()).catch((error) => {
        console.error('No se pudo sincronizar compras:', errorMessage(error));
      });
    }, syncIntervalSeconds * 1000);
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`El puerto ${port} ya esta en uso. Cierra el servidor anterior o cambia PORT en .env.`);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});
