# Backend full-stack (Express + Postgres). Railway inyecta $PORT.
# Node 22: requerido por @supabase/supabase-js (WebSocket nativo).
FROM node:22-alpine
WORKDIR /app

# Instala dependencias con lockfile (reproducible)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copia el resto (server, db, public/)
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
