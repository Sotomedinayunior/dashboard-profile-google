# 🚀 Nelly RAC — Dashboard Setup en Vercel

## Requisitos previos
- Cuenta en [Vercel](https://vercel.com) (gratis)
- Cuenta en [Google Cloud Console](https://console.cloud.google.com)
- Propiedad en [Google Search Console](https://search.google.com/search-console)
- Perfil en [Google My Business](https://business.google.com) / Business Profile

---

## PASO 1 — Crear credenciales OAuth2 en Google Cloud

1. Ve a [console.cloud.google.com](https://console.cloud.google.com)
2. Crea un **nuevo proyecto** → ej. `nelly-dashboard`
3. Ve a **APIs & Services → Library** y activa estas 4 APIs:
   - **Google Search Console API**
   - **My Business Business Information API**
   - **My Business Account Management API**
   - **Business Profile Performance API**
4. Ve a **APIs & Services → Credentials → + Create Credentials → OAuth client ID**
   - Tipo de aplicación: **Web application**
   - Nombre: `Nelly Dashboard`
   - Authorized redirect URIs: agrega `https://TU-PROYECTO.vercel.app/api/callback`
   - (También agrega `http://localhost:3000/api/callback` para pruebas locales)
5. Copia el **Client ID** y el **Client Secret** — los necesitarás luego.

> ⚠️ Si es la primera vez que usas OAuth en este proyecto, Google pedirá configurar la **pantalla de consentimiento** (OAuth consent screen). Complétala con nombre de app, email y dominio.

---

## PASO 2 — Hacer deploy en Vercel

1. Sube la carpeta del proyecto a un repo en GitHub
2. Ve a [vercel.com](https://vercel.com) → **Add New Project** → importa tu repo
3. Vercel detecta automáticamente el `package.json` — el deploy se hace solo
4. Una vez deployed, anota tu URL: `https://TU-PROYECTO.vercel.app`

---

## PASO 3 — Obtener el Refresh Token

El refresh token es la "llave permanente" que el dashboard usa para llamar a las APIs sin que tengas que re-autenticarte. Se obtiene una sola vez.

**Opción A: Via tu dashboard en Vercel (recomendado)**
1. Agrega temporalmente las variables `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en Vercel → Settings → Environment Variables
2. Haz un redeploy
3. Ve a `https://TU-PROYECTO.vercel.app/api/auth`
4. Autoriza con tu cuenta de Google
5. La página `/api/callback` te mostrará el **refresh token** y también el **GMB_LOCATION_NAME**

**Opción B: Localmente con Node.js**
```bash
# 1. Clona el repo y entra a la carpeta
cd dashboard-nelly

# 2. Instala dependencias
npm install
npm install dotenv   # solo para este script

# 3. Crea .env.local con tu client_id y client_secret
cp .env.example .env.local
# Edita .env.local con tus valores reales

# 4. Corre el script
node scripts/get-tokens.js

# 5. Abre el URL que imprime, autoriza, pega el código
# El script imprime el refresh_token y el GMB_LOCATION_NAME
```

---

## PASO 4 — Configurar variables de entorno en Vercel

Ve a **Vercel → Tu Proyecto → Settings → Environment Variables** y agrega:

| Variable | Valor |
|----------|-------|
| `GOOGLE_CLIENT_ID` | `123456789-abc.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | `GOCSPX-tu_secret` |
| `GOOGLE_REFRESH_TOKEN` | El token obtenido en el Paso 3 |
| `GSC_PROPERTY` | `https://nellyrac.do/` (con slash al final) |
| `GMB_LOCATION_NAME` | `accounts/123456789/locations/987654321` |

Luego haz **Redeploy** (Deployments → ⋯ → Redeploy).

---

## PASO 5 — Verificar

1. Abre `https://TU-PROYECTO.vercel.app`
2. El dashboard carga datos en vivo desde Google
3. La pestaña **Google Mi Negocio** muestra reseñas, vistas y acciones
4. El badge en la esquina dice **● En vivo**

Los datos se actualizan automáticamente en cada visita (Vercel cachea por 1 hora).

---

## Estructura del proyecto

```
dashboard-nelly/
├── index.html              ← Dashboard frontend (se sirve como página principal)
├── package.json            ← Dependencias Node.js
├── vercel.json             ← Config de Vercel
├── .env.example            ← Template de variables de entorno
├── api/
│   ├── data.js             ← GET /api/data  → datos GSC + GMB combinados
│   ├── auth.js             ← GET /api/auth  → inicio del flujo OAuth2 (setup)
│   └── callback.js         ← GET /api/callback → recibe código, muestra token
└── scripts/
    └── get-tokens.js       ← Script local para obtener refresh token via CLI
```

---

## Cómo funciona

```
Usuario abre el dashboard
        ↓
index.html hace fetch('/api/data')
        ↓
api/data.js usa el refresh_token para obtener un access_token
        ↓
Fetches en paralelo:
  ├── Google Search Console API → clicks, impresiones, queries, países, dispositivos
  └── Google My Business APIs  → reseñas, vistas del perfil, llamadas, clics, rutas
        ↓
Retorna JSON combinado → index.html renderiza todo
```

---

## Notas importantes

- GSC tiene un **lag de ~2 días** en los datos — es normal
- GMB Performance API agrega datos con **1-3 días de retraso**
- El cache de Vercel (`s-maxage=3600`) significa que los datos se refrescan **cada hora**
- Si faltan las env vars, el dashboard muestra datos de demostración (no da error)
- Para datos más frescos en local: `vercel dev` (requiere CLI de Vercel instalada)

---

## ¿Necesitas ayuda?

- Para errores de OAuth: revisa que el redirect URI en Google Cloud coincida exactamente con tu URL de Vercel
- Para errores de GMB: asegúrate de que la cuenta de Google tiene acceso al Business Profile
- Para errores de GSC: la cuenta debe tener al menos permiso de "Restricted" en la propiedad
