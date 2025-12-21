const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 Minutes
const DEFAULT_MAX_SIZE = 500;

interface CacheEntry<T> {
    timestamp: number;
    value: T;
}

/**
 * A generic Least Recently Used (LRU) cache with Time-To-Live (TTL).
 */
export class SimpleLRUCache<T> {
    private cache = new Map<string, CacheEntry<T>>();
    private ttl: number;
    private maxSize: number;

    constructor(ttlMs: number = DEFAULT_TTL_MS, maxSize: number = DEFAULT_MAX_SIZE) {
        this.ttl = ttlMs;
        this.maxSize = maxSize;
    }

    get(key: string): T | undefined {
        const entry = this.cache.get(key);
        if (!entry) return undefined;

        if (Date.now() - entry.timestamp > this.ttl) {
            this.cache.delete(key);
            return undefined;
        }

        // Refresh LRU position
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.value;
    }

    set(key: string, value: T): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) this.cache.delete(firstKey);
        }
        this.cache.set(key, { timestamp: Date.now(), value });
    }

    delete(key: string): void {
        this.cache.delete(key);
    }

    deleteByPrefix(prefix: string): void {
        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) {
                this.cache.delete(key);
            }
        }
    }
}