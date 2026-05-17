import 'dotenv/config';
import { fechaBogota, sincronizarCompras } from './comprasService.js';

const fecha = process.argv[2] || fechaBogota();

sincronizarCompras(fecha)
  .then((resumen) => {
    console.log(JSON.stringify(resumen, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
