FROM node:20-alpine

WORKDIR /app

# Копируем shared конфигурацию
COPY services/shared ./shared

# Копируем package.json и index.js сервиса
COPY services/diary-service/package.json ./diary-service/
COPY services/diary-service/index.js ./diary-service/

# Устанавливаем зависимости для shared
WORKDIR /app/shared
RUN npm install

# Устанавливаем зависимости для diary-service
WORKDIR /app/diary-service
RUN npm install

# Открываем порт
EXPOSE 3005

# Запускаем сервис из директории diary-service
WORKDIR /app/diary-service
CMD ["npm", "start"]
