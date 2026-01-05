FROM node:20-alpine

# Устанавливаем зависимости для Playwright
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Устанавливаем Playwright браузеры
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# Копируем shared конфигурацию
COPY services/shared ./shared
COPY services/recipe-parser-service/package.json ./recipe-parser-service/
COPY services/recipe-parser-service/index.js ./recipe-parser-service/

# Устанавливаем зависимости
WORKDIR /app/recipe-parser-service
RUN npm install

# Устанавливаем зависимости для shared
WORKDIR /app/shared
RUN npm install

WORKDIR /app/recipe-parser-service

CMD ["npm", "start"]

