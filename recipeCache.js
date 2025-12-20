// Кэш для рецептов - снижает нагрузку при повторных запросах
const recipeCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 час

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

