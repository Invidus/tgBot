FROM node:20-alpine

WORKDIR /app

# Копируем shared config
COPY services/shared ./services/shared

# Копируем package.json для payment-webhook-service
COPY services/payment-webhook-service/package.json ./services/payment-webhook-service/

# Устанавливаем зависимости для shared
WORKDIR /app/services/shared
RUN npm install

# Устанавливаем зависимости для payment-webhook-service
WORKDIR /app/services/payment-webhook-service
RUN npm install

# Копируем исходный код
COPY services/payment-webhook-service/index.js ./

# Создаем симлинк на shared для правильных путей импорта
RUN ln -s /app/services/shared ./shared || true

WORKDIR /app/services/payment-webhook-service

EXPOSE 3003

CMD ["npm", "start"]
