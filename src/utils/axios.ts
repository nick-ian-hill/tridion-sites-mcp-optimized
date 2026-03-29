import axios, { InternalAxiosRequestConfig } from "axios";

// Extend Axios config type to allow custom retry tracking properties
declare module 'axios' {
    interface InternalAxiosRequestConfig {
        _networkRetryCount?: number;
        _retry?: boolean;
    }
}

// --- Configuration Constants ---

// 1. Service API (Bearer Token) - For automated/service-to-service calls
const CORE_API_URL = process.env.CORE_API_URL?.trim() ||
    "http://10.100.92.199:81/api/v3.0";

// 2. Experience Space UI API (Session Cookie) - For Chat Panel/Browser calls
const UI_API_URL = "http://10.100.92.199:81/ui/api/v3.0";

// Auth Endpoint Configuration
const AUTH_TOKEN_URL = process.env.AUTH_TOKEN_URL?.trim() ||
    "http://external-dxui-dev-sites-stg.ted.nl.sdldev.net/access-management/connect/token";
const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID?.trim();
const AUTH_CLIENT_SECRET = process.env.AUTH_CLIENT_SECRET?.trim();

// --- Fallback Session ID Configuration ---
// By default, this is null.
// To FORCE the use of a hardcoded cookie (e.g. for debugging without a chat panel),
// comment out the 'null' line and uncomment the string line below it.

const DEBUG_USER_SESSION_ID: string | null = null;
//const DEBUG_USER_SESSION_ID = "CfDJ8HqChz77QTRDjHSWXedojsv4aXITmQAPcTnloj5dL8fesWUfg9pdK-isyR9py7iGyFW69dZO0p8UUQUx6dg9xCUOMok_f0yoIzlokxjuIAFZtrhLKdCY4bqeW3z6DWi0R1ThvEDqIFSYSM0MwHVg6K0kXH8sY_UwChFHMn_rk1enH584hL_Voh_j9CIAqAK-vtZsJWqvojTxXegS2yVONq8wafM2Ytn597-zUNy8WcMEDcWT6taYSnOY3AwxbjDqYo_XG3opWexwWjifB_TzoIrK3rOz4bfUwG0_4p57rzX8S2EU5riUDPGI6RDhxANJ2ejxbuNdvMUQO8elyPZHnHA";


// --- Token Cache ---
let cachedAccessToken: string | null = null;
let tokenExpirationTime: number = 0;
let refreshPromise: Promise<string> | null = null;

// Network error codes that are safe to retry (transient connectivity failures)
const RETRYABLE_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const TOKEN_REQUEST_TIMEOUT_MS = 10000; // Fail fast per attempt rather than waiting for OS TCP timeout
const MAX_TOKEN_FETCH_RETRIES = 3;
const MAX_API_RETRIES = 3;
const API_RETRY_BASE_DELAY_MS = 1000;

/**
 * Fetches a new access token or returns a valid cached one.
 * Implements promise locking to handle concurrent refresh requests,
 * and retries with exponential backoff on transient network errors.
 */
async function getDebugAccessToken(): Promise<string> {
    // 1. If we have a cached token and it's not expired (buffer of 30s), use it.
    if (cachedAccessToken && Date.now() < tokenExpirationTime - 30000) {
        return cachedAccessToken;
    }

    // 2. If a refresh is already in progress, wait for it instead of starting a new one.
    if (refreshPromise) {
        return refreshPromise;
    }

    // 3. Start a new refresh operation
    refreshPromise = (async () => {
        try {
            // Basic Auth Header for Token Endpoint
            const credentials = `${AUTH_CLIENT_ID}:${AUTH_CLIENT_SECRET}`;
            const encodedCredentials = Buffer.from(credentials).toString('base64');

            // Body with grant_type
            const params = new URLSearchParams();
            params.append("grant_type", "client_credentials");

            let lastError: unknown;
            for (let attempt = 1; attempt <= MAX_TOKEN_FETCH_RETRIES; attempt++) {
                if (attempt === 1) {
                    console.log("[AUTH] Fetching new access token...");
                } else {
                    const delayMs = Math.pow(2, attempt - 2) * 1000; // 1s, 2s
                    console.warn(`[AUTH] Retrying token fetch (attempt ${attempt}/${MAX_TOKEN_FETCH_RETRIES}) after ${delayMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }

                try {
                    const response = await axios.post(AUTH_TOKEN_URL, params, {
                        timeout: TOKEN_REQUEST_TIMEOUT_MS,
                        headers: {
                            "Content-Type": "application/x-www-form-urlencoded",
                            "Authorization": `Basic ${encodedCredentials}`
                        }
                    });

                    if (response.data && response.data.access_token) {
                        cachedAccessToken = response.data.access_token;
                        // Calculate absolute expiry time (expires_in is in seconds)
                        const expiresIn = response.data.expires_in || 3600;
                        tokenExpirationTime = Date.now() + (expiresIn * 1000);
                        return cachedAccessToken as string;
                    } else {
                        throw new Error("Invalid response format from token endpoint.");
                    }
                } catch (error: any) {
                    lastError = error;
                    // Only retry on transient network errors, not auth/format errors
                    const code: string | undefined = error?.code ?? error?.cause?.code;
                    if (!RETRYABLE_ERROR_CODES.has(code ?? '') || attempt === MAX_TOKEN_FETCH_RETRIES) {
                        break;
                    }
                    console.warn(`[AUTH] Token fetch attempt ${attempt} failed with ${code}.`);
                }
            }

            console.error("[AUTH] Failed to fetch access token after all retries:", lastError);
            throw lastError;
        } finally {
            // Always clear the lock when the promise settles (success or fail)
            refreshPromise = null;
        }
    })();

    return refreshPromise;
}

export const createAuthenticatedAxios = (userSessionId?: string | null, referer?: string) => {

    // --- Strategy Selection ---

    // Apply fallback if configured (default is null, so this does nothing unless you change the const above)
    userSessionId = userSessionId || DEBUG_USER_SESSION_ID;

    // Decide Mode
    const useSessionMode = !!userSessionId;
    const activeBaseUrl = useSessionMode ? UI_API_URL : CORE_API_URL;

    const config: any = {
        baseURL: activeBaseUrl,
        headers: {
            "Accept": "application/json"
        }
    };

    // --- Mode 1: UI Session Mode (Cookie) ---
    // Used when Chat Panel provides ID OR when DEBUG_USER_SESSION_ID is uncommented
    if (useSessionMode) {
        config.headers["Cookie"] = `UserSessionID=${userSessionId}`;
        config.headers["x-csrf"] = "1";
        config.headers["request-client"] = "experience-space";
    }
    // --- Mode 2: Service Mode (Bearer Token) ---
    // Used when running automated scripts with no user session
    else {
        // We purposefully do NOT set Cookie/x-csrf here.
        // The Bearer token will be injected via interceptor.
    }

    if (referer) {
        config.headers["Referer"] = referer;
    }

    const instance = axios.create(config);

    const LOGGING_ENABLED = false;

    if (LOGGING_ENABLED) {
        instance.interceptors.request.use(
            (config: InternalAxiosRequestConfig) => {
                const modeLabel = config.headers['Cookie'] ? "UI/Cookie Mode" : "Service/Bearer Mode";
                console.groupCollapsed(`[AXIOS] (${modeLabel}) ${config.method?.toUpperCase()} Request to ${config.url}`);
                console.log("Full URL:", `${config.baseURL}${config.url}`);

                if (config.headers['Authorization']) console.log("Auth:", "Bearer Token Set");
                if (config.headers['Cookie']) console.log("Auth:", "UserSessionID Cookie Set");

                if (config.params) console.log("Query Params:", config.params);
                if (config.data) console.log("Request Body:", JSON.stringify(config.data, null, 2));
                console.groupEnd();
                return config;
            },
            (error) => {
                console.error("[AXIOS] Request Error:", error);
                return Promise.reject(error);
            }
        );

        instance.interceptors.response.use(
            (response) => {
                console.log(`[AXIOS] Response from ${response.config.url}:`, response.status, response.data);
                return response;
            },
            (error) => {
                if (axios.isAxiosError(error)) {
                    // Only log as error if it's NOT a 401 that we are about to retry
                    // (The retry interceptor below handles the 401 logic, but this logging one runs first or parallel depending on stack order)
                    // We'll log it anyway for visibility.
                    console.error(`[AXIOS] Response Error from ${error.config?.url}:`, error.response?.status, error.response?.data);
                } else {
                    console.error("[AXIOS] Non-Axios Response Error:", error);
                }
                return Promise.reject(error);
            }
        );
    }

    // --- Network Error Retry Interceptor (both modes) ---
    // Registered before the Service Mode interceptors so it runs last in LIFO order,
    // acting as the outermost fallback after other interceptors have had a chance to handle the error.
    instance.interceptors.response.use(
        (response) => response,
        async (error) => {
            const config = error.config;
            if (!config) return Promise.reject(error);

            const code: string | undefined = error?.code ?? error?.cause?.code;
            config._networkRetryCount = config._networkRetryCount ?? 0;

            if (RETRYABLE_ERROR_CODES.has(code ?? '') && config._networkRetryCount < MAX_API_RETRIES) {
                config._networkRetryCount++;
                const delayMs = Math.pow(2, config._networkRetryCount - 1) * API_RETRY_BASE_DELAY_MS; // 1s, 2s, 4s
                console.warn(`[API] Network error ${code} on ${config.url}. Retrying (${config._networkRetryCount}/${MAX_API_RETRIES}) after ${delayMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                return instance(config);
            }

            return Promise.reject(error);
        }
    );

    // --- Async Interceptor for Service Mode (Bearer Token) ---
    if (!useSessionMode) {
        // 1. Request Interceptor: Inject Token
        instance.interceptors.request.use(async (config) => {
            try {
                // Only inject Bearer token if we are NOT in Session Mode
                if (!config.headers['Cookie']) {
                    const token = await getDebugAccessToken();
                    config.headers['Authorization'] = `Bearer ${token}`;
                }
                return config;
            } catch (error) {
                console.error("[AUTH] Interceptor failed:", error);
                return Promise.reject(error);
            }
        }, error => Promise.reject(error));

        // 2. Response Interceptor: Handle 401 Retries
        instance.interceptors.response.use(
            (response) => response,
            async (error) => {
                const originalRequest = error.config;

                // Check if it's a 401 and we haven't already retried this request
                if (error.response?.status === 401 && !originalRequest._retry) {
                    originalRequest._retry = true; // Mark as retried to prevent infinite loops

                    try {
                        // Check if another concurrent request already refreshed the token.
                        // If the cached token differs from the one that caused this 401, skip the
                        // refresh and retry directly with the already-current token.
                        const tokenUsed = (originalRequest.headers['Authorization'] as string | undefined)?.split(' ')[1];
                        if (cachedAccessToken && cachedAccessToken !== tokenUsed) {
                            console.warn("[AUTH] 401 detected but token already refreshed by another request. Retrying with current token.");
                            originalRequest.headers['Authorization'] = `Bearer ${cachedAccessToken}`;
                            return instance(originalRequest);
                        }

                        console.warn("[AUTH] 401 Unauthorized detected. Clearing cache and refreshing token...");
                        // Force clear the cache to ensure getDebugAccessToken triggers a refresh
                        // (or joins an existing one)
                        cachedAccessToken = null;
                        tokenExpirationTime = 0;

                        // Fetch a completely new token (or await the pending refresh)
                        const newToken = await getDebugAccessToken();

                        // Update the failed request's Authorization header
                        originalRequest.headers['Authorization'] = `Bearer ${newToken}`;

                        // Retry the original request with the new token
                        return instance(originalRequest);
                    } catch (refreshError) {
                        console.error("[AUTH] Token refresh failed:", refreshError);
                        // Return the original error if refresh fails so the caller knows the request failed
                        return Promise.reject(error);
                    }
                }

                // If not 401 or already retried, just reject
                return Promise.reject(error);
            }
        );
    }

    return instance;
};