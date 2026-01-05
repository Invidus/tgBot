FROM node:18-alpine

WORKDIR /app

# Копируем shared конфигурацию
COPY services/shared ./shared

# Копируем bot-service
COPY services/bot-service ./bot-service

# Устанавливаем зависимости для shared
WORKDIR /app/shared
RUN npm install

# Устанавливаем зависимости для bot-service
WORKDIR /app/bot-service
RUN npm install

# Создаем симлинк на shared для правильных путей импорта
RUN ln -s /app/shared ./shared || true

WORKDIR /app/bot-service

CMD ["npm", "start"]

