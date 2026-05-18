import 'dotenv/config';
import { fechaBogota, sincronizarCompras, sincronizarComprasRecientes, sincronizarComprasRango } from './comprasService.js';

async function run() {
  const [arg, value, hasta] = process.argv.slice(2);

  if (arg === '--recent') {
    return sincronizarComprasRecientes(Number(value || process.env.SYNC_BACKFILL_DAYS || 30));
  }

  if (arg === '--range') {
    return sincronizarComprasRango(value, hasta || fechaBogota());
  }

  return sincronizarCompras(arg || fechaBogota());
}

run()
  .then((resumen) => {
    console.log(JSON.stringify(resumen, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
