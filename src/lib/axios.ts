import axios, { InternalAxiosRequestConfig } from "axios";

// CMS API base and UserSessionID cookie
const CMS_BASE_API_URL = "http://10.100.92.199:81/ui/api/v3.0";
const USER_SESSION_ID = "CfDJ8MFdR0UUsZtPi5oTnQ5q67IHy5JXB08Vsi_OhpmMP0tbWo2ruMw6W3TnmjgmXgDmvgsbEjeLM9rVz-Fet7o3vmn_dzT7hb5dGdQjDvCfOKhOePIqjaBS2ETo6YX5ajuB9CH8ls7yH7PY_jwX4sd45CL-iEFTCA24WHjBr9S4qdOqbJs9_zI-oppreibuQqCq9BdcNvvn9CNdHqKg9d-62kvcsZ2M-La9qp5llEn0cxdpld7qmyiv3Djnd-RmM68Ha2jwJRtCnuaEfv1ASW_lTANLDrRmznfu6RWfmG9yPqRntvravHBfF5tnGTi_NjgZbHOD0cENT75HnPg6MpQfQos";

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
