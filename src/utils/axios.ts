import axios, { InternalAxiosRequestConfig } from "axios";

// This is the single, correct URL for the Tridion backend API.
const CMS_BASE_API_URL = "http://10.100.92.199:81/ui/api/v3.0";

const DEBUG_USER_SESSION_ID = "CfDJ8PzgcQaZmn1NsXkfq43IXJXLyTyVFWtQV6TlOQaunKWgCdzwXzsyyjSU9zkxDT7IbKFkFWnnEP0xlStXzCYSiJat65YlYP0dvrn36O-P58LXirswr5LbG7aV87fFo9HI-T54x9RGV5QmmIR6acqMuIQjecsRpQe3Q1LPpM7ykR8znlm-zHrh58aDJXvNf8nJWMaovk1Nm7O-2uy-gEnTGSewHP5GmYD04vCbUQ0EmBo2FoDyNKcEXXkHhIEZo4eqvMhp-N9LDpwwZ9wPpfTVtgXJ0rYSsZA8C2e9Y6HN1ZHzpC5BjhhATx6raFjd_WatRAAnw4kepe0RK-URvAEPLlY";

export const createAuthenticatedAxios = (userSessionId?: string | null, referer?: string) => {
    const sessionId = userSessionId || DEBUG_USER_SESSION_ID;

    if (!sessionId) {
        throw new Error("UserSessionID is missing.");
    }
    
    if (!userSessionId) {
        console.warn(`[AUTH] No UserSessionID provided. Falling back to DEBUG_USER_SESSION_ID.`);
    }
    
    const headers: Record<string, string> = {
        "Accept": "application/json",
        "Cookie": `UserSessionID=${sessionId}`,
        "x-csrf": "1",
        "request-client": "experience-space"
    };

    // The Referer is only needed for browser-initiated flows.
    if (referer) {
        headers["Referer"] = referer;
    }

    const instance = axios.create({
        baseURL: CMS_BASE_API_URL,
        headers: headers
    });

    const LOGGING_ENABLED = true;

    if (LOGGING_ENABLED) {
        instance.interceptors.request.use(
            (config: InternalAxiosRequestConfig) => {
                console.groupCollapsed(`[AXIOS] ${config.method?.toUpperCase()} Request to ${config.url}`);
                console.log("Full URL:", `${config.baseURL}${config.url}`);
                if (config.params) {
                    console.log("Query Params:", config.params);
                }
                if (config.data) {
                    console.log("Request Body:", config.data);
                }
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
                    console.error(`[AXIOS] Response Error from ${error.config?.url}:`, error.response?.status, error.response?.data);
                } else {
                    console.error("[AXIOS] Non-Axios Response Error:", error);
                }
                return Promise.reject(error);
            }
        );
    }

    return instance;
};