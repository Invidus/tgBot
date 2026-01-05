FROM node:18-alpine

WORKDIR /app

# Копируем shared конфигурацию
COPY services/shared ./shared
COPY services/database-service/package.json ./database-service/
COPY services/database-service/index.js ./database-service/

# Устанавливаем зависимости
WORKDIR /app/database-service
RUN npm install

# Устанавливаем зависимости для shared
WORKDIR /app/shared
RUN npm install

WORKDIR /app/database-service

CMD ["npm", "start"]

