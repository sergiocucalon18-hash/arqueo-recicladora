# Arqueo Recicladora

Web app React + Firebase Firestore para arqueo de turnos.

## Ejecutar localmente

```bash
npm install
npm run dev
```

## Desplegar en Vercel

1. Sube esta carpeta a un repositorio.
2. Crea un proyecto en Vercel y selecciona el repositorio.
3. Vercel detecta Vite con `vercel.json`.
4. Ejecuta el despliegue.

## Firebase

La app usa Firestore en tiempo real en el documento:

```txt
arqueos/almetales
```

PIN inicial del dueno: `1234`.
Clave inicial de empleado: `empleado`.

Activa Firebase Authentication con proveedor anonimo y publica las reglas de `firestore.rules` para que solo clientes autenticados puedan leer y escribir el documento de arqueo.
