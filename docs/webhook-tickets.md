# Webhook de completado de tickets — Nebo Inbox

Cuando un ticket se **completa** (o cambia de estado) en el project-manager, llama a
este webhook. Nosotros marcamos el ticket como resuelto y **notificamos al usuario
que lo creó**.

## Endpoint

```
POST https://whatsapp.neboaiconsulting.com/api/tickets/webhook
```

## Autenticación

Envía el secreto compartido de **cualquiera** de estas formas (usa la que te sea
más cómoda de configurar):

| Forma | Cómo |
|---|---|
| Header (recomendado) | `x-webhook-secret: <SECRETO>` |
| Bearer | `Authorization: Bearer <SECRETO>` |
| Query string | `...?secret=<SECRETO>` |
| En el body | `{ "secret": "<SECRETO>", ... }` |

Sin el secreto correcto → **401**.

## Cuerpo (JSON)

Lo mínimo:

```json
{ "taskId": "<id de la tarea en el project-manager>", "status": "Completado" }
```

- **`taskId`** — el id que devolviste al crear la tarea (campo `task.id`). Es la
  clave con la que casamos el ticket. También aceptamos los nombres `id`,
  `external_id`, `externalId`, `task_id`, y **anidados** dentro de `task`, `data`,
  `record`, `ticket` o `payload` (así que puedes enviarnos el objeto de la tarea tal
  cual).
- **`status`** — el nuevo estado. Se considera **completado** si contiene: complet·,
  done, finaliz·, cerr·, resuelt·, closed o resolved. También vale `"completed": true`.
  Cualquier otro valor deja el ticket "en progreso".

Ejemplos que aceptamos, todos equivalentes:

```json
{ "taskId": "cmrx…", "status": "Completado" }
{ "task": { "id": "cmrx…", "stage": "Done" } }
{ "id": "cmrx…", "completed": true }
```

## Respuestas

| Código | Significado |
|---|---|
| `200` | `{ "ok": true, "id": "<nuestro id>", "status": "completado", "completado": true }` |
| `401` | Secreto inválido |
| `404` | No hay ningún ticket con ese `taskId` |
| `400` | Falta el `taskId` |
| `503` | El webhook no está configurado (falta el secreto en nuestro servidor) |

## Notas

- **Idempotente**: llamar varias veces con "completado" no duplica el aviso al
  usuario. Podéis reintentar sin miedo.
- Podéis probar que la URL está viva con un `GET` al mismo endpoint (responde `ok`).
- El aviso al usuario aparece en la campana de la app como *"✅ Tu ticket fue
  resuelto"* con el título del ticket.

## Prueba rápida (curl)

```bash
curl -X POST https://whatsapp.neboaiconsulting.com/api/tickets/webhook \
  -H "x-webhook-secret: <SECRETO>" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"<id de una tarea real>","status":"Completado"}'
```
