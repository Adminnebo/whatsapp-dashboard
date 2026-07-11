# Analítica WhatsApp

Dashboard de métricas sobre las conversaciones (Express + Postgres). Lee la **misma
base** de Railway y calcula:

- **Mensajes enviados / recibidos** (KPIs, por día, por hora)
- **Horas pico** de actividad
- **Tiempo de respuesta** — mediana / promedio / p90 (gap entre un mensaje entrante y
  la siguiente respuesta saliente en la misma conversación; refleja lo que tarda el bot)
- **Último mensaje enviado**
- **Tipos** de mensaje enviados (texto/imagen/documento/audio)
- **Cotizaciones enviadas** — configurable (aún no hay tabla en esta base)

## Correr local
```bash
npm install
DATABASE_URL="postgresql://..." TZ_DISPLAY="America/Santo_Domingo" node server.js
# http://localhost:8080
```

## Cotizaciones
Cuando exista la tabla, define la variable `QUOTES_SQL` con un SELECT que devuelva el
conteo, usando `$1` = fecha "desde" del rango. Ej.:
```
QUOTES_SQL=SELECT count(*)::int AS n FROM cotizaciones WHERE created_at >= $1
```
El KPI "Cotizaciones" pasa de *Pendiente* a mostrar el número.

## Deploy en Railway
1. Nuevo servicio desde el repo (detecta el **Dockerfile**).
2. Variables: `DATABASE_URL`, `TZ_DISPLAY`, y opcional `QUOTES_SQL`.

## Notas
- Solo **lee** la base (no escribe nada).
- `/api/stats?days=7|30|90|all` devuelve todo el JSON de métricas.
- El "tiempo de respuesta" es el que se puede derivar de la BD. Si quieres el tiempo
  real del **run de n8n** (duración de la ejecución del workflow), se puede agregar
  consultando la API de ejecuciones de n8n — dilo y lo integro.
