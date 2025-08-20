import axios, { InternalAxiosRequestConfig } from "axios";

// CMS API base and UserSessionID cookie
const CMS_BASE_API_URL = "http://10.100.92.199:81/ui/api/v3.0";
const USER_SESSION_ID = "CfDJ8MFdR0UUsZtPi5oTnQ5q67LboVa_D4ycIVp6qHfB619BJjD0QQ5NaSt0MBv99uj1vl_iBp6xnYyJ7lgCOo6kYU77DTFNN3oOdfGdKKVVIA9_rsoHBEaMrHXzeQ7Ziwzz6ubJU7Xz6R7cRPY_Fpy3Nt90SYthi42x0ZMGi0ycRjdZLTS_21T1trLVY7dOaJskObUKmukkvXx5Lg89ym-i1Xu4dZ_z5xcPgd1i1Ni_2gPEWoeDbV8tl2sXxVRc74Upn0qhcKNZSq8EKo8E6vaTv9JQ1wItKfYJ6zrVWc7xjhKN74OIybB0Mpl0-EhSOYSab_Vfm9teUQeyc1sep1lnyp0";

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
