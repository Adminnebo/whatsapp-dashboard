# Auth reutilizable (Supabase)

Login por **email + contraseña** con Supabase Auth + **panel admin** para crear
usuarios, asignarles rol (`admin` / `agent`) y vincularlos a un usuario de GHL.

Pensado para compartir el **mismo proyecto Supabase entre varias apps** → un solo
directorio de usuarios para todos tus proyectos.

## Variables de entorno
```
SUPABASE_URL=...
SUPABASE_ANON_KEY=...            # pública (valida tokens y va al frontend)
SUPABASE_SERVICE_ROLE_KEY=...    # secreta (crear/administrar usuarios) — NUNCA al repo
```
Sin estas variables, el módulo queda en **modo abierto** (no bloquea) — así no
rompe nada mientras terminas de configurarlo.

## Puesta en marcha (esta app)
1. `npm i` (ya está `@supabase/supabase-js` en package.json).
2. En Supabase: corre `auth/schema.sql` (SQL Editor).
3. Authentication → Providers → Email → **desactiva** "Allow new users to sign up"
   (solo el admin crea usuarios).
4. Crea tu primer usuario admin y márcalo admin (ver final de `schema.sql`).
5. Pon las variables de entorno y despliega.
6. Login en `/login.html` · panel de usuarios en `/users.html`.

## Reutilizar en otro proyecto Express
1. Copia `auth/` (backend) y del frontend: `public/js/auth.js`, `public/login.html`, `public/users.html`.
2. `npm i @supabase/supabase-js`
3. En tu `server.js`:
   ```js
   const authRouter = require('./auth/router');
   const { requireAuth } = require('./auth/middleware');
   const { configured } = require('./auth/supabase');
   app.use('/api/auth', authRouter);
   const OPEN = new Set(['/health']); // endpoints máquina-a-máquina sin sesión
   app.use('/api', (req, res, next) => {
     if (!configured) return next();
     if (req.path.startsWith('/auth/') || OPEN.has(req.path)) return next();
     return requireAuth(req, res, next);
   });
   ```
4. En el frontend: carga `js/auth.js` y arranca la app tras `await Auth.requireSession()`.
   Incluye el token en tus llamadas con `Authorization: Bearer ${Auth.currentToken}`
   (o usa `Auth.fetch(url, opts)`), y usa `Auth.signOut()` para cerrar sesión.

## Endpoints
- `GET  /api/auth/config`      → config pública (URL + anon key)
- `GET  /api/auth/me`          → usuario + perfil (requiere sesión)
- `GET  /api/auth/users`       → lista (admin)
- `POST /api/auth/users`       → crear `{email,password,role,fullName,ghlUserId}` (admin)
- `PATCH /api/auth/users/:id`  → actualizar rol / contraseña / GHL (admin)
- `DELETE /api/auth/users/:id` → eliminar (admin)
