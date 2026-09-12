FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
RUN addgroup --system app && adduser --system --ingroup app app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist/ dist/
# Las migraciones y su configuración viajan en la imagen: el initContainer del
# Deployment las ejecuta con esta misma imagen antes de que arranque el servicio
# (ver arquitectura/migraciones.md). `.sequelizerc` es lo que evita el
# "Cannot find /app/config/config.json" que sufren otros servicios.
COPY migrations/ migrations/
COPY .sequelizerc .sequelizerc
COPY sequelize.config.cjs sequelize.config.cjs
USER app
EXPOSE 3014
CMD ["node", "dist/main.js"]
