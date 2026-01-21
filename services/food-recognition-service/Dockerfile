FROM node:20-alpine

WORKDIR /app

# Копируем shared конфигурацию
COPY services/shared ./shared
COPY services/food-recognition-service/package.json ./food-recognition-service/
COPY services/food-recognition-service/index.js ./food-recognition-service/

# Устанавливаем зависимости
WORKDIR /app/food-recognition-service
RUN npm install

# Устанавливаем зависимости для shared
WORKDIR /app/shared
RUN npm install

WORKDIR /app/food-recognition-service

CMD ["npm", "start"]
