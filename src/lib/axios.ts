import axios, { InternalAxiosRequestConfig } from "axios";

// CMS API base and UserSessionID cookie
const CMS_BASE_API_URL = "http://10.100.92.199:81/ui/api/v3.0";
const USER_SESSION_ID = "CfDJ8MFdR0UUsZtPi5oTnQ5q67JXDfhM5UbbKD5cYB8ujfOsF3CFAFHHUw9U_UIqXTShwG8gp3x4RXluu3Szr8n7AH0Kfbcwxx1BSK6iLf7REPAEflsNJcaWJ0R8eZM48YuHYWm0550lwkAj4B0n1OMn17-aKYVRW5AqqIsWeAUII6IBwrgJDFQBhTiLaWNlhKCNCf2rMoBTRmwsm_TIuplfnj065bH2iB2R0m60SIxMxwCyM2nlf9TGVaTDqZFvEI_Dv3pvRqZN3iDd5vC5QN9KJHgSB7haZMoNlMgeNmY_Gt1kIeR7PwBUg0WirAql5jY_uLI1gSPfl3ZETdlyxwFIVdw";

export const authenticatedAxios = axios.create({
  baseURL: CMS_BASE_API_URL,
  headers: {
    "Cookie": `UserSessionID=${USER_SESSION_ID}`,
    "Accept": "application/json"
  }
});

const LOGGING_ENABLED = true;

if (LOGGING_ENABLED) {

  authenticatedAxios.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
      // This function will run before every request is sent

      console.groupCollapsed(`[AXIOS] ${config.method?.toUpperCase()} Request to ${config.url}`);

      console.log("Full URL:", `${config.baseURL}${config.url}`);

      if (config.params) {
        console.log("Query Params:", config.params);
      }

      if (config.data) {
        console.log("Request Body:", config.data);
      }

      console.groupEnd();

      // It's crucial to return the config object, otherwise the request will be blocked
      return config;
    },
    (error) => {
      // This function will run if there's an error setting up the request
      console.error("[AXIOS] Request Error:", error);
      return Promise.reject(error);
    }
  );

  authenticatedAxios.interceptors.response.use(
    (response) => {
      // Any status code that lie within the range of 2xx cause this function to trigger
      console.log(`[AXIOS] Response from ${response.config.url}:`, response.status, response.data);
      return response;
    },
    (error) => {
      // Any status codes that falls outside the range of 2xx cause this function to trigger
      console.error(`[AXIOS] Response Error from ${error.config.url}:`, error.response?.status, error.response?.data);
      return Promise.reject(error);
    }
  );
}
