import { AxiosInstance } from "axios";
import { SimpleLRUCache } from "./lruCache.js"; 

// Instantiate the shared cache class
const modelCache = new SimpleLRUCache<any>();

// Map to track requests that are currently executing to prevent Cache Stampedes
const inFlightRequests = new Map<string, Promise<any>>();

export async function getCachedDefaultModel(
    itemType: string,
    containerId: string,
    axiosInstance: AxiosInstance
): Promise<any> {
    const cacheKey = `${itemType}:${containerId}`;
    
    // 1. Check Completed Cache
    const cachedValue = modelCache.get(cacheKey);
    if (cachedValue) {
        // Return a DEEP COPY to prevent tools from mutating the cached model
        return JSON.parse(JSON.stringify(cachedValue));
    }

    // 2. Check In-Flight Requests (Stampede Prevention)
    if (inFlightRequests.has(cacheKey)) {
        // Another concurrent thread is already fetching this exact model.
        // Wait for it to finish instead of making a duplicate API call.
        const data = await inFlightRequests.get(cacheKey);
        return JSON.parse(JSON.stringify(data));
    }

    // 3. Cache Miss - Fetch from API
    console.log(`[Cache] Fetching Default Model for ${itemType} in ${containerId}`);
    
    // Create the promise but don't await it immediately
    const fetchPromise = axiosInstance.get(`/item/defaultModel/${itemType}`, {
        params: { containerId }
    }).then(response => {
        if (response.status === 200) {
            modelCache.set(cacheKey, response.data);
            return response.data;
        } else {
            throw new Error(`Failed to fetch default model: ${response.status} ${response.statusText}`);
        }
    }).finally(() => {
        // Once the request finishes (success or failure), remove it from the in-flight map
        inFlightRequests.delete(cacheKey);
    });

    // Store the pending promise in the map for concurrent threads to find
    inFlightRequests.set(cacheKey, fetchPromise);

    // Await the fetch for the initial thread
    const data = await fetchPromise;
    return JSON.parse(JSON.stringify(data));
}