import { chromium } from "playwright";

let browser = null;
let isInitializing = false;
let activePages = 0;
const MAX_CONCURRENT_PAGES = 2; // Уменьшено для снижения нагрузки при множестве пользователей
const requestQueue = []; // Очередь запросов
let processingQueue = false;

/**
 * Проверяет, жив ли браузер
 */
const isBrowserAlive = () => {
  return browser && browser.isConnected();
};

/**
 * Инициализирует браузер (если еще не инициализирован)
 */
export const initBrowser = async () => {
  if (browser && isBrowserAlive()) {
    return browser;
  }

  // Если браузер мертв, закрываем его
  if (browser && !isBrowserAlive()) {
    browser = null;
  }

  if (isInitializing) {
    // Ждем, пока другой запрос инициализирует браузер
    let waitCount = 0;
    while (isInitializing && waitCount < 50) { // Максимум 5 секунд ожидания
      await new Promise(resolve => setTimeout(resolve, 100));
      waitCount++;
    }
    if (browser && isBrowserAlive()) {
      return browser;
    }
  }

  isInitializing = true;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-images',
        '--disable-css',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-ipc-flooding-protection'
      ]
    });
    console.log('✅ Браузер Playwright инициализирован');
  } catch (error) {
    console.error('❌ Ошибка инициализации браузера:', error);
    isInitializing = false;
    throw error;
  }
  isInitializing = false;
  return browser;
};

/**
 * Получает новую страницу из переиспользуемого браузера (с очередью)
 */
export const getPage = async () => {
  return new Promise((resolve, reject) => {
    // Добавляем запрос в очередь
    requestQueue.push({ resolve, reject, timestamp: Date.now() });

    // Запускаем обработку очереди если еще не запущена
    if (!processingQueue) {
      processQueue();
    }
  });
};

/**
 * Обрабатывает очередь запросов
 */
const processQueue = async () => {
  if (processingQueue) return;
  processingQueue = true;

  while (requestQueue.length > 0) {
    // Проверяем, есть ли место для новой страницы
    if (activePages >= MAX_CONCURRENT_PAGES) {
      // Ждем освобождения места
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }

    // Удаляем старые запросы (старше 30 секунд)
    const now = Date.now();
    while (requestQueue.length > 0 && now - requestQueue[0].timestamp > 30000) {
      const oldRequest = requestQueue.shift();
      oldRequest.reject(new Error('Время ожидания истекло. Попробуйте позже.'));
    }

    if (requestQueue.length === 0) break;

    const request = requestQueue.shift();

    try {
      // Проверяем и инициализируем браузер если нужно
      if (!browser || !isBrowserAlive()) {
        await initBrowser();
      }

      activePages++;
      const page = await browser.newPage();

      // Устанавливаем таймауты для страницы (уменьшены для снижения нагрузки)
      page.setDefaultTimeout(15000); // 15 секунд
      page.setDefaultNavigationTimeout(15000);

      // Блокируем загрузку ненужных ресурсов для ускорения
      await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        // Блокируем изображения, шрифты, медиа - оставляем только документы, скрипты, стили
        if (['image', 'font', 'media', 'stylesheet'].includes(resourceType)) {
          route.abort();
        } else {
          route.continue();
        }
      });

      // Устанавливаем User-Agent
      await page.setExtraHTTPHeaders({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
      });

      request.resolve(page);
    } catch (error) {
      activePages--;
      // Если браузер упал, пытаемся пересоздать
      if (error.message.includes('Target closed') || error.message.includes('Browser closed')) {
        browser = null;
        request.reject(new Error('Браузер был закрыт. Попробуйте еще раз.'));
      } else {
        request.reject(error);
      }
    }
  }

  processingQueue = false;
};

/**
 * Уведомляет о закрытии страницы
 */
export const releasePage = () => {
  if (activePages > 0) {
    activePages--;
  }
};

/**
 * Закрывает браузер
 */
export const closeBrowser = async () => {
  if (browser) {
    await browser.close();
    browser = null;
    console.log('✅ Браузер Playwright закрыт');
  }
};

