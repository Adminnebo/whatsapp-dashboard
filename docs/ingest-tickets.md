# Lo que Nebo envía al project-manager al crear un ticket

Contrato de **salida**: qué mandamos nosotros cuando un usuario crea un ticket
desde la web o la app. (El sentido contrario — avisarnos de que la tarea se
completó — está en [webhook-tickets.md](webhook-tickets.md).)

## Petición

```
POST https://project-manager-production-1787.up.railway.app/api/ingest/tasks
Content-Type: application/json
x-api-key: <la API key del project-manager>
```

## Body — con adjuntos

```json
{
  "title": "[SPEC] El boton de enviar no responde",
  "description": "Al pulsar Enviar en el chat no pasa nada. Adjunto captura y el log.\n\n— — —\nReportado por: Jorge\nCategoría: Error / falla\nOrigen: web (inbox)\n\nAdjuntos (2):\n- captura.png (4 KB): https://whatsapp.neboaiconsulting.com/api/tickets/file?id=5&sig=d89babcfb18bd20d9683f645\n- reporte.pdf (1 KB): https://whatsapp.neboaiconsulting.com/api/tickets/file?id=6&sig=56b7bc487eab9b0fa065578c",
  "priority": "HIGH",
  "stage": "Nuevo",
  "attachments": [
    {
      "name": "captura.png",
      "url": "https://whatsapp.neboaiconsulting.com/api/tickets/file?id=5&sig=d89babcfb18bd20d9683f645",
      "mime": "image/png",
      "size": 4008
    },
    {
      "name": "reporte.pdf",
      "url": "https://whatsapp.neboaiconsulting.com/api/tickets/file?id=6&sig=56b7bc487eab9b0fa065578c",
      "mime": "application/pdf",
      "size": 69
    }
  ]
}
```

## Body — sin adjuntos

`attachments` **siempre viaja**; sin archivos es un array vacío, nunca se omite.

```json
{
  "title": "[SPEC] sin adjuntos",
  "description": "Duda sobre el pipeline.\n\n— — —\nReportado por: Jorge\nCategoría: Duda\nOrigen: android (nebo-movil)",
  "priority": "LOW",
  "stage": "Nuevo",
  "attachments": []
}
```

## Campos

| Campo | Tipo | Valores | Nota |
|---|---|---|---|
| `title` | string | libre, ≤ 120 car. | el asunto que escribe el usuario |
| `description` | string | libre, multilínea | texto del usuario + bloque de metadatos + bloque de adjuntos |
| `priority` | string | `LOW` · `MEDIUM` · `HIGH` · `URGENT` | siempre uno de esos cuatro |
| `stage` | string | `Nuevo` | constante hoy |
| `attachments` | array | `[]` o hasta **5** objetos | siempre presente |
| `attachments[].name` | string | nombre original del archivo | puede repetirse entre tickets |
| `attachments[].url` | string | URL absoluta https | descarga directa, sin cabeceras |
| `attachments[].mime` | string | ej. `image/png`, `application/pdf` | el que reportó el navegador |
| `attachments[].size` | number | bytes | máximo 10 485 760 (10 MB) |

### Estructura de `description`

Tres bloques separados por líneas en blanco:

```
<lo que escribió el usuario>

— — —
Reportado por: <nombre o email>
Categoría: <categoría>            ← puede faltar
Origen: <web|android> (<app>)

Adjuntos (N):                     ← este bloque solo aparece si N > 0
- <nombre> (<peso>): <url>
```

Si preferís no parsear el texto, **usad `attachments`**: lleva lo mismo, estructurado.

## Sobre las URLs de los adjuntos

- **Se abren sin autenticación**: la autorización va firmada (HMAC) en el propio
  parámetro `sig`. No mandéis `Authorization` ni la API key.
- **No caducan.**
- Se sirven con `Content-Disposition: inline`, así que imágenes y PDFs se ven en
  el navegador en lugar de descargarse.
- El binario vive en el servidor de Nebo. Si queréis copiarlo a vuestro
  almacenamiento, descargadlo con un `GET` normal al recibir la tarea.
- Manipular `id` o `sig` devuelve **403**; un id inexistente, **404**.

## Respuesta que esperamos

Necesitamos el **id de la tarea** para poder casarla después con el webhook de
completado. Lo buscamos en varios sitios, así que cualquiera de estas vale:

```json
{ "task": { "id": "cmrxymo3k0001fa6qdnrzn19s" } }
{ "id": "cmrxymo3k0001fa6qdnrzn19s" }
{ "data": { "id": "cmrxymo3k0001fa6qdnrzn19s" } }
```

Si la respuesta no trae ningún id, el ticket se crea igual pero **el completado
automático no funcionará** (no habría con qué emparejar la tarea).

Cualquier código HTTP distinto de 2xx lo tratamos como fallo: se lo decimos al
usuario y **descartamos el ticket** de nuestro lado, para no dejarlo huérfano.
