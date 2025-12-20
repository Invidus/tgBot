import { chromium } from "playwright";

let browser = null;
let isInitializing = false;
let activePages = 0;
let playwrightAvailable = true; // Флаг доступности Playwright
const MAX_CONCURRENT_PAGES = 2; // Уменьшено для снижения нагрузки при множестве пользователей

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
    playwrightAvailable = true;
  } catch (error) {
    console.error('❌ Ошибка инициализации браузера:', error);
    console.error('⚠️ Playwright недоступен, будет использоваться fallback на axios');
    playwrightAvailable = false;
    isInitializing = false;
    throw error;
  }
  isInitializing = false;
  return browser;
};

/**
 * Проверяет, доступен ли Playwright
 */
export const isPlaywrightAvailable = () => {
  return playwrightAvailable;
};

/**
 * Проверяет, инициализирован ли браузер
 */
export const isBrowserInitialized = () => {
  return browser !== null && isBrowserAlive();
};

/**
 * Получает новую страницу из переиспользуемого браузера
 */
export const getPage = async () => {
  // Если Playwright недоступен, выбрасываем ошибку для fallback
  if (!playwrightAvailable) {
    throw new Error('PLAYWRIGHT_UNAVAILABLE');
  }

  console.log(`📄 Запрос страницы. Активных страниц: ${activePages}/${MAX_CONCURRENT_PAGES}`);

  // Простая проверка лимита без сложной очереди
  let waitCount = 0;
  while (activePages >= MAX_CONCURRENT_PAGES && waitCount < 60) {
    await new Promise(resolve => setTimeout(resolve, 500));
    waitCount++;
  }

  if (activePages >= MAX_CONCURRENT_PAGES) {
    console.error('❌ Превышен лимит одновременных страниц');
    throw new Error('Превышено максимальное количество одновременных запросов. Попробуйте позже.');
  }

  // Проверяем и инициализируем браузер если нужно
  if (!browser || !isBrowserAlive()) {
    console.log('🌐 Инициализация браузера...');
    try {
      await initBrowser();
    } catch (error) {
      playwrightAvailable = false;
      console.error('❌ Не удалось инициализировать браузер, используем fallback');
      throw new Error('PLAYWRIGHT_UNAVAILABLE');
    }
  }

  try {
    activePages++;
    console.log(`✅ Создание новой страницы. Активных: ${activePages}`);
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

    return page;
  } catch (error) {
    activePages--;
    console.error('❌ Ошибка при создании страницы:', error);
    // Если браузер упал, пытаемся пересоздать
    if (error.message && (error.message.includes('Target closed') || error.message.includes('Browser closed'))) {
      browser = null;
      throw new Error('Браузер был закрыт. Попробуйте еще раз.');
    }
    throw error;
  }
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

