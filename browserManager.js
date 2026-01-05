import { chromium } from "playwright";

// Конфигурация для масштабирования
const MAX_CONCURRENT_PAGES = 10; // Увеличено для поддержки большего количества пользователей
const BROWSER_POOL_SIZE = 2; // Количество браузеров в пуле
const MAX_QUEUE_SIZE = 50; // Максимальный размер очереди ожидания
const PAGE_TIMEOUT = 15000; // 15 секунд
const QUEUE_TIMEOUT = 30000; // 30 секунд ожидания в очереди

// Пул браузеров
const browserPool = [];
let isInitializingPool = false;
let activePages = 0;
let playwrightAvailable = true;

// Очередь запросов (Promise-based вместо polling)
const requestQueue = [];
let processingQueue = false;

/**
 * Проверяет, жив ли браузер
 */
const isBrowserAlive = (browser) => {
  return browser && browser.isConnected();
};

/**
 * Инициализирует один браузер
 */
const initSingleBrowser = async () => {
  try {
    const browser = await chromium.launch({
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
        '--disable-ipc-flooding-protection',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });
    console.log('✅ Браузер Playwright инициализирован');
    return browser;
  } catch (error) {
    console.error('❌ Ошибка инициализации браузера:', error);
    throw error;
  }
};

/**
 * Инициализирует пул браузеров
 */
export const initBrowserPool = async () => {
  if (browserPool.length >= BROWSER_POOL_SIZE) {
    // Проверяем, что все браузеры живы
    const aliveBrowsers = browserPool.filter(b => isBrowserAlive(b));
    if (aliveBrowsers.length === BROWSER_POOL_SIZE) {
      return;
    }
    // Удаляем мертвые браузеры
    browserPool.length = 0;
    browserPool.push(...aliveBrowsers);
  }

  if (isInitializingPool) {
    // Ждем, пока другой запрос инициализирует пул
    let waitCount = 0;
    while (isInitializingPool && waitCount < 50) {
      await new Promise(resolve => setTimeout(resolve, 100));
      waitCount++;
    }
    if (browserPool.length >= BROWSER_POOL_SIZE) {
      return;
    }
  }

  isInitializingPool = true;
  try {
    const browsersToCreate = BROWSER_POOL_SIZE - browserPool.length;
    console.log(`🌐 Инициализация пула браузеров: создание ${browsersToCreate} браузеров...`);

    const newBrowsers = await Promise.all(
      Array(browsersToCreate).fill(null).map(() => initSingleBrowser())
    );

    browserPool.push(...newBrowsers);
    console.log(`✅ Пул браузеров инициализирован: ${browserPool.length} браузеров`);
    playwrightAvailable = true;
  } catch (error) {
    console.error('❌ Ошибка инициализации пула браузеров:', error);
    if (browserPool.length === 0) {
      playwrightAvailable = false;
      console.error('⚠️ Playwright недоступен, будет использоваться fallback на axios');
    }
  } finally {
    isInitializingPool = false;
  }
};

/**
 * Получает доступный браузер из пула
 */
const getAvailableBrowser = () => {
  // Фильтруем живые браузеры
  const aliveBrowsers = browserPool.filter(b => isBrowserAlive(b));

  if (aliveBrowsers.length === 0) {
    return null;
  }

  // Используем round-robin для распределения нагрузки
  // (можно улучшить, выбирая браузер с наименьшим количеством страниц)
  return aliveBrowsers[Math.floor(Math.random() * aliveBrowsers.length)];
};

/**
 * Обрабатывает очередь запросов
 */
const processQueue = async () => {
  if (processingQueue || requestQueue.length === 0) {
    return;
  }

  processingQueue = true;

  while (requestQueue.length > 0 && activePages < MAX_CONCURRENT_PAGES) {
    const request = requestQueue.shift();

    try {
      const browser = getAvailableBrowser();
      if (!browser) {
        // Нет доступных браузеров, возвращаем запрос в очередь
        requestQueue.unshift(request);
        break;
      }

      activePages++;
      console.log(`✅ Обработка запроса из очереди. Активных страниц: ${activePages}/${MAX_CONCURRENT_PAGES}, Очередь: ${requestQueue.length}`);

      let page = null;
      let pageCreated = false;

      try {
        page = await browser.newPage();
        pageCreated = true;

        page.setDefaultTimeout(PAGE_TIMEOUT);
        page.setDefaultNavigationTimeout(PAGE_TIMEOUT);

        // Блокируем загрузку ненужных ресурсов
        await page.route('**/*', (route) => {
          const resourceType = route.request().resourceType();
          if (request.allowImages) {
            if (['font', 'media', 'stylesheet'].includes(resourceType)) {
              route.abort();
            } else {
              route.continue();
            }
          } else {
            if (['image', 'font', 'media', 'stylesheet'].includes(resourceType)) {
              route.abort();
            } else {
              route.continue();
            }
          }
        });

        await page.setExtraHTTPHeaders({
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
        });

        // Разрешаем Promise с полученной страницей
        clearTimeout(request.timeout);
        request.resolve(page);
      } catch (error) {
        activePages--;
        if (pageCreated && page) {
          page.close().catch(() => {});
        }
        clearTimeout(request.timeout);
        request.reject(error);
      }
    } catch (error) {
      console.error('❌ Ошибка при обработке запроса из очереди:', error);
      if (request.timeout) {
        clearTimeout(request.timeout);
      }
      request.reject(error);
    }
  }

  processingQueue = false;
};

/**
 * Получает новую страницу из пула браузеров
 * @param {boolean} allowImages - Разрешить загрузку изображений (по умолчанию false)
 */
export const getPage = async (allowImages = false) => {
  if (!playwrightAvailable) {
    throw new Error('PLAYWRIGHT_UNAVAILABLE');
  }

  // Если пул не инициализирован, инициализируем его
  if (browserPool.length === 0) {
    await initBrowserPool();
    if (browserPool.length === 0) {
      throw new Error('PLAYWRIGHT_UNAVAILABLE');
    }
  }

  // Если есть свободные слоты, создаем страницу сразу
  if (activePages < MAX_CONCURRENT_PAGES) {
    const browser = getAvailableBrowser();
    if (browser) {
      try {
        activePages++;
        console.log(`📄 Создание страницы. Активных: ${activePages}/${MAX_CONCURRENT_PAGES}`);

        const page = await browser.newPage();
        page.setDefaultTimeout(PAGE_TIMEOUT);
        page.setDefaultNavigationTimeout(PAGE_TIMEOUT);

        await page.route('**/*', (route) => {
          const resourceType = route.request().resourceType();
          if (allowImages) {
            if (['font', 'media', 'stylesheet'].includes(resourceType)) {
              route.abort();
            } else {
              route.continue();
            }
          } else {
            if (['image', 'font', 'media', 'stylesheet'].includes(resourceType)) {
              route.abort();
            } else {
              route.continue();
            }
          }
        });

        await page.setExtraHTTPHeaders({
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
        });

        return page;
      } catch (error) {
        activePages--;
        console.error('❌ Ошибка при создании страницы:', error);
        throw error;
      }
    }
  }

  // Если нет свободных слотов, добавляем в очередь
  if (requestQueue.length >= MAX_QUEUE_SIZE) {
    console.error('❌ Очередь переполнена');
    throw new Error('Превышено максимальное количество одновременных запросов. Попробуйте позже.');
  }

  console.log(`📋 Запрос добавлен в очередь. Очередь: ${requestQueue.length + 1}/${MAX_QUEUE_SIZE}, Активных: ${activePages}/${MAX_CONCURRENT_PAGES}`);

  return new Promise((resolve, reject) => {
    const request = {
      allowImages,
      resolve,
      reject,
      timestamp: Date.now()
    };

    // Таймаут для запроса в очереди
    const timeout = setTimeout(() => {
      const index = requestQueue.indexOf(request);
      if (index !== -1) {
        requestQueue.splice(index, 1);
        reject(new Error('Превышено время ожидания в очереди'));
      }
    }, QUEUE_TIMEOUT);

    request.timeout = timeout;
    requestQueue.push(request);

    // Запускаем обработку очереди
    processQueue();
  });
};

/**
 * Уведомляет о закрытии страницы
 */
export const releasePage = () => {
  if (activePages > 0) {
    activePages--;
    console.log(`🗑️ Страница освобождена. Активных: ${activePages}/${MAX_CONCURRENT_PAGES}, Очередь: ${requestQueue.length}`);

    // Продолжаем обработку очереди
    processQueue();
  } else {
    console.warn('⚠️ Попытка освободить страницу, но счетчик уже 0');
  }
};

/**
 * Проверяет, доступен ли Playwright
 */
export const isPlaywrightAvailable = () => {
  return playwrightAvailable;
};

/**
 * Проверяет, инициализирован ли пул браузеров
 */
export const isBrowserInitialized = () => {
  return browserPool.length > 0 && browserPool.some(b => isBrowserAlive(b));
};

/**
 * Закрывает все браузеры в пуле
 */
export const closeBrowser = async () => {
  console.log('🔄 Закрытие пула браузеров...');
  await Promise.all(
    browserPool.map(browser =>
      browser.close().catch(err => console.error('Ошибка закрытия браузера:', err))
    )
  );
  browserPool.length = 0;
  activePages = 0;
  requestQueue.length = 0;
  console.log('✅ Пул браузеров закрыт');
};

/**
 * Получает статистику пула браузеров
 */
export const getPoolStats = () => {
  return {
    browsers: browserPool.length,
    aliveBrowsers: browserPool.filter(b => isBrowserAlive(b)).length,
    activePages,
    queueSize: requestQueue.length,
    maxConcurrentPages: MAX_CONCURRENT_PAGES,
    maxQueueSize: MAX_QUEUE_SIZE
  };
};

// Обратная совместимость: экспортируем initBrowser для существующего кода
export const initBrowser = initBrowserPool;
