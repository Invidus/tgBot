FROM node:20-alpine

WORKDIR /app

# Копируем package.json для установки зависимостей
COPY services/diary-service/package.json ./
COPY services/shared ./services/shared

# Устанавливаем зависимости
RUN npm install

# Копируем код сервиса
COPY services/diary-service/index.js ./

# Открываем порт
EXPOSE 3005

# Запускаем сервис
CMD ["npm", "start"]
