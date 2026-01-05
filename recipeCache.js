// Кэш для рецептов - снижает нагрузку при повторных запросах
const recipeCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 час
const MAX_CACHE_SIZE = 1000; // Максимум 1000 рецептов в кэше

/**
 * Получает рецепт из кэша
 */
export const getCachedRecipe = (url) => {
  const cached = recipeCache.get(url);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  // Удаляем устаревший кэш
  if (cached) {
    recipeCache.delete(url);
  }
  return null;
};

/**
 * Сохраняет рецепт в кэш
 */
export const cacheRecipe = (url, data) => {
  // Если кэш переполнен, удаляем самые старые записи
  if (recipeCache.size >= MAX_CACHE_SIZE) {
    const entries = Array.from(recipeCache.entries());
    // Сортируем по времени и удаляем 10% самых старых
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = Math.floor(MAX_CACHE_SIZE * 0.1);
    for (let i = 0; i < toDelete; i++) {
      recipeCache.delete(entries[i][0]);
    }
  }

  recipeCache.set(url, {
    data,
    timestamp: Date.now()
  });
};

/**
 * Очищает старый кэш
 */
export const cleanupCache = () => {
  const now = Date.now();
  for (const [url, cached] of recipeCache.entries()) {
    if (now - cached.timestamp > CACHE_TTL) {
      recipeCache.delete(url);
    }
  }
};

// Очистка кэша каждые 30 минут
setInterval(cleanupCache, 30 * 60 * 1000);

