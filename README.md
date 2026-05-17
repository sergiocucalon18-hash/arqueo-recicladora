# Arqueo Recicladora

Web app React + Firebase Firestore para arqueo de turnos.

## Ejecutar localmente

```bash
npm install
npm run server
npm run dev
```

En Windows tambien puedes usar `abrir_app.bat`; abre la API de compras y luego la app web.

Para que la sincronizacion MySQL -> Firestore arranque sola al encender el PC, ejecuta `instalar_sincronizacion_inicio.bat`. Esto crea una tarea de Windows que inicia el backend al entrar a tu usuario. El backend sincroniza una vez al arrancar y luego cada `SYNC_INTERVAL_SECONDS` segundos. Para desactivarlo, ejecuta `quitar_sincronizacion_inicio.bat`.

## Backend Node.js + Express

Copia `.env.example` como `.env` y completa:

```txt
MYSQL_HOST
MYSQL_PORT
MYSQL_USER
MYSQL_PASSWORD
MYSQL_DATABASE
```

El backend lee `tbl_consolidado_compras`, calcula el total diario y guarda el resumen en Firestore en:

```txt
compras_diarias/{YYYY-MM-DD}
```

Arrancar API:

```bash
npm run server
```

Endpoint principal:

```txt
GET http://localhost:4000/compras-hoy
```

Tambien existe:

```txt
GET /compras?fecha=YYYY-MM-DD
GET /compras-opciones
GET /reporte-compras?desde=YYYY-MM-DDTHH:mm&hasta=YYYY-MM-DDTHH:mm&material=CHATARRA&jornada=DIURNA
POST /sync-compras-hoy
GET /health
```

El servidor sincroniza automaticamente al iniciar y luego cada `SYNC_INTERVAL_SECONDS` segundos.

La app React escucha ese documento en tiempo real y muestra las compras sincronizadas del dia. Al crear un cierre nuevo, intenta llenar el total de compras del turno usando el campo `jornada`.

La vista privada del dueno incluye una seccion `Reportes` para consultar compras por material, jornada, dia completo o rangos exactos de fecha y hora. Ejemplo: chatarra desde `2026-05-16T14:00` hasta `2026-05-17T16:00`.

## Desplegar en Vercel

1. Sube esta carpeta a un repositorio.
2. Crea un proyecto en Vercel y selecciona el repositorio.
3. Vercel detecta Vite con `vercel.json`.
4. Ejecuta el despliegue.

Si el proyecto ya esta conectado a GitHub y Vercel, ejecuta `actualizar_vercel.bat` en Windows. Ese archivo crea un commit, lo sube a `origin/main` y Vercel debe desplegar automaticamente la version nueva.

## Firebase

La app usa Firestore en tiempo real en el documento:

```txt
arqueos/almetales
```

PIN inicial del dueno: `1234`.
Clave inicial de empleado: `empleado`.

Activa Firebase Authentication con proveedor anonimo y publica las reglas de `firestore.rules` para que solo clientes autenticados puedan leer y escribir el documento de arqueo.

Para el backend configura una credencial de servidor con `GOOGLE_APPLICATION_CREDENTIALS` o `FIREBASE_SERVICE_ACCOUNT_JSON`. Las reglas permiten lectura de compras al cliente autenticado y dejan la escritura de `compras_diarias` solo al backend con Firebase Admin.

Si la app muestra `Missing or insufficient permissions` en compras, publica las reglas incluidas en este proyecto:

```bash
firebase deploy --only firestore:rules --project almetales-eadf3
```

Mientras esas reglas no esten publicadas, la app intenta cargar las compras desde la API local (`GET /compras?fecha=YYYY-MM-DD`) para que el arqueo pueda seguir funcionando en este PC.
