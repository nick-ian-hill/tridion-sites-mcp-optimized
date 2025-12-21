// src/utils/defaultModelCache.ts
import { AxiosInstance } from "axios";
import { SimpleLRUCache } from "./lruCache.js"; 

// Instantiate the shared cache class
const modelCache = new SimpleLRUCache<any>();

export async function getCachedDefaultModel(
    itemType: string,
    containerId: string,
    axiosInstance: AxiosInstance
): Promise<any> {
    const cacheKey = `${itemType}:${containerId}`;
    
    // 1. Check Cache
    const cachedValue = modelCache.get(cacheKey);
    if (cachedValue) {
        // Return a DEEP COPY to prevent tools from mutating the cached model
        return JSON.parse(JSON.stringify(cachedValue));
    }

    // 2. Cache Miss - Fetch from API
    console.log(`[Cache] Fetching Default Model for ${itemType} in ${containerId}`);
    const response = await axiosInstance.get(`/item/defaultModel/${itemType}`, {
        params: { containerId }
    });

    if (response.status === 200) {
        modelCache.set(cacheKey, response.data);
        return JSON.parse(JSON.stringify(response.data));
    } else {
        throw new Error(`Failed to fetch default model: ${response.status} ${response.statusText}`);
    }
}