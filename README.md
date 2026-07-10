# Dashboard WhatsApp — versión dinámica (full-stack)

Réplica del dashboard de conversaciones, pero **dinámica**: un backend propio
(**Express + Postgres**) sirve el frontend y expone `/api/*`, consultando Postgres
directamente y haciendo de proxy a **GoHighLevel** y **WhatsApp Cloud API**.
Reemplaza los webhooks de n8n para todo lo que es solo BD/GHL/envío.

> Proyecto separado del dashboard estático (`Dashboard-Lucas`). Usa la **misma base**
> de Railway, así que comparte los datos (conversaciones, mensajes, contactos).

## Correr local
```bash
npm install
# define las variables (ver .env.example) y arranca:
DATABASE_URL="postgresql://..." GHL_PIT="pit-..." LOCATION_ID="..." \
WHATSAPP_TOKEN="EAAG..." WHATSAPP_PHONE_ID="302766349596365" \
node server.js
# abre http://localhost:8080
```

## Endpoints (`/api`)
| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/conversations` | Lista de conversaciones (Postgres) |
| GET | `/api/messages?conversationId=` | Mensajes de una conversación + marca leídos |
| GET | `/api/media?id=` | Sirve el binario guardado (bytea) |
| POST | `/api/save-in` / `/api/save-out` | Guardar mensaje (JSON, base64 o multipart) |
| POST | `/api/delete-conversation` | Elimina conversación + mensajes (CASCADE) |
| GET | `/api/bot-state` · `/api/bot-enabled` · POST `/api/bot-set` | Flag global on/off del bot |
| GET | `/api/ghl-contact?contactId=` | Datos completos del contacto en GHL |
| GET | `/api/ghl-name?contactId=` | Solo el nombre (liviano) |
| POST | `/api/ghl-set-field` | Escribe el custom field `bot_status` (STOP) |
| GET | `/api/handoff` | contactIds con etiqueta `handoff` en GHL |
| POST | `/api/send` | Enviar texto por WhatsApp + guardar |
| POST | `/api/send-media` | Enviar adjunto por WhatsApp + guardar |
| GET | `/api/db-setup` | Crea/migra tablas (también corre al arrancar) |

## Deploy en Railway
1. Nuevo servicio desde este repo (Railway detecta Node por `package.json` → `npm start`).
2. Configura las **Variables** (ver `.env.example`): `DATABASE_URL`, `GHL_PIT`,
   `LOCATION_ID`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `PUBLIC_URL`.
3. El frontend ya apunta a `/api` (mismo origen).

## Qué NO se movió (sigue en n8n)
- El **flujo entrante de Meta** (descarga media de WhatsApp) → debe hacer POST a `/api/save-in`.
- El **agente/bot de IA** → consulta `/api/bot-enabled` (filtro global) + `bot_status` (por contacto).
