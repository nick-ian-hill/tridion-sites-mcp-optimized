import { AxiosInstance } from "axios";

// Reuse the LRU Cache logic or import if exported. 
// For independence, we define a minimal version here.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 Minutes
const modelCache = new Map<string, { timestamp: number; value: any }>();

export async function getCachedDefaultModel(
    itemType: string,
    containerId: string,
    axiosInstance: AxiosInstance
): Promise<any> {
    const cacheKey = `${itemType}:${containerId}`;
    const now = Date.now();
    
    // 1. Check Cache
    const entry = modelCache.get(cacheKey);
    if (entry) {
        if (now - entry.timestamp < CACHE_TTL_MS) {
            // Cache Hit
            // Return a DEEP COPY to prevent tools from mutating the cached model
            return JSON.parse(JSON.stringify(entry.value));
        } else {
            // Expired
            modelCache.delete(cacheKey);
        }
    }

    // 2. Cache Miss - Fetch from API
    console.log(`[Cache] Fetching Default Model for ${itemType} in ${containerId}`);
    const response = await axiosInstance.get(`/item/defaultModel/${itemType}`, {
        params: { containerId }
    });

    if (response.status === 200) {
        modelCache.set(cacheKey, { timestamp: now, value: response.data });
        // Return a copy
        return JSON.parse(JSON.stringify(response.data));
    } else {
        throw new Error(`Failed to fetch default model: ${response.status} ${response.statusText}`);
    }
}