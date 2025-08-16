import axios, { InternalAxiosRequestConfig } from "axios";

// CMS API base and UserSessionID cookie
const CMS_BASE_API_URL = "http://10.100.92.199:81/ui/api/v3.0";
const USER_SESSION_ID = "CfDJ8MFdR0UUsZtPi5oTnQ5q67KgGnP-dWw6mwV0XyoGc0OsKaIQk9Ep5w21q4Xq6lvvXSeeO5Jxa2xLwc3GC97S1tsI5z8_e-oTeSPy4PHeANiNEXG3TG828Uh2kUQHh0yDgao4JcnNUo6Y3F60l6c8t8UiUqHI0Tk826RNNbdOIFBAb3H_PDPhRZDWuEWe3EuIFPhfmh8yiUh83YLXUVVG4-PiVlGnKJVL26_Sx_2D2aPz_tTB3o7rSQqbjgOcvniQRotO90mTSnB7frKGfh8qFPVcWsJqGEL2Y_GVQEp_bZcihAY-JyMieS09s6Ql0yxA1zyLDC0YdJTEtHUgpX-PWv4";

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
