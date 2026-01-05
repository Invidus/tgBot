FROM node:20-alpine

# Устанавливаем зависимости для Playwright
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    libc6-compat

# Проверяем путь к Chromium
RUN which chromium-browser || which chromium || echo "Chromium not found"

WORKDIR /app

# Копируем shared конфигурацию
COPY services/shared ./shared
COPY services/recipe-parser-service/package.json ./recipe-parser-service/
COPY services/recipe-parser-service/index.js ./recipe-parser-service/

# Устанавливаем зависимости
WORKDIR /app/recipe-parser-service
RUN npm install

# Устанавливаем браузеры Playwright
RUN npx playwright install chromium

# Устанавливаем зависимости для shared
WORKDIR /app/shared
RUN npm install

WORKDIR /app/recipe-parser-service

CMD ["npm", "start"]

