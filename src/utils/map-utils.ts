/**
 * Get an existing value from a Map, or create and insert a default if the key is missing.
 * Eliminates the need for `map.get(key)!` after `if (!map.has(key)) map.set(key, ...)`.
 */
export function getOrCreate<K, V>(map: Map<K, V>, key: K, factory: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const value = factory();
  map.set(key, value);
  return value;
}
