/* =========================================================
   waHash — extrae el hash estable de un wamid de Meta.

   El wamid con el que LLEGA un mensaje y el context.id con el que Meta
   lo CITA después son distintos (uno se construye sobre el teléfono, el
   otro sobre el user_id de la identidad nueva de Meta). Lo único estable
   entre ambos es el hash final. Por ahí se resuelven los replies:
       context_hash del reply  ==  message_hash del mensaje citado.

   El hash es la corrida final de caracteres ASCII hex antes del 0x00 final.
   NO se busca el marcador 0x12 0x18: Meta usa 0x11 para salientes y 0x12
   para entrantes, y el largo del hash varía (18, 20 o 32).

   Es seguro escanear desde el final: los bytes de longitud (0x12..0x20)
   nunca caen en el rango ASCII de '0'-'9' (0x30-0x39) ni 'A'-'F'
   (0x41-0x46), así que no se confunden con el hash.

   Formato no documentado por Meta; deducido de payloads reales. Si Meta lo
   cambia, waHash devuelve null y los replies degradan a "sin cita" — no
   rompen. Un null NUNCA debe tirar error.
   ========================================================= */
'use strict';

function waHash(wamid) {
  if (!wamid) return null;
  const b64 = String(wamid).replace(/^wamid\./, '');
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (_) { return null; }

  const esHex = (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46);

  let end = buf.length;
  while (end > 0 && !esHex(buf[end - 1])) end--;
  let start = end;
  while (start > 0 && esHex(buf[start - 1])) start--;

  const h = buf.toString('latin1', start, end);
  return h.length >= 16 ? h : null;
}

module.exports = { waHash };
