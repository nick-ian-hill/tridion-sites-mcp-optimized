import axios, { InternalAxiosRequestConfig } from "axios";

// CMS API base and UserSessionID cookie
const CMS_BASE_API_URL = "http://10.100.92.199:81/ui/api/v3.0";
const USER_SESSION_ID = "CfDJ8MFdR0UUsZtPi5oTnQ5q67J7c2L2GEBD2R37TKTDeNT2vpqhcWGUJSxZrXKaMkgqzs4xOY-QX540oun_kXAU2uLACaDihxjbQrpLnqmjdi00IJvw8twNove_QimOmJ_sjv7TQdHjONwEgvSiy0Ecpeq9y9bKbUkYly67U_cHHewBLYoTtBz5s0YYX6ltp-xycTE0rZlLi8fiWk5eb6HXVpzCY5XYc7uqz6bBAf0JH5lczb-jFlgrWVREuJoGFIkNSuvrQ2iNjAnpTkjYhhTmp-VOcoLsf39q8SwW17f4IQQpbAeN2YFnDvx80f8dw3GkRCMgP6_pW4IEEMmSCIM10K8";

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
