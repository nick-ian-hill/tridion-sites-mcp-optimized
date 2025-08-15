import axios from "axios";

// CMS API base and UserSessionID cookie
const CMS_BASE_API_URL = "http://10.100.92.199:81/ui/api/v3.0";
const USER_SESSION_ID = "CfDJ8MFdR0UUsZtPi5oTnQ5q67KGYcV8fgeZmTnKZ7rl8YH0LQsi554PnEvc5RgKGbwaMbAFtuINnE9WIB647oAwB6tWHvJ9ZzxecVx4U6TKbNxo86eRWIay0blyZA44ErRGv8PJuOgGUuWkq1IdRNLMci7vJBSJvVZQCfA0xWDbcQU9ZqkozbSn0-_vF-jQqz2PdDzkXxaJJxKRel-7mJYOHNCHnBvzyIA8ePyU-WVa22fq2uWojdKZbEIpQs-IT0PA83whTB5A-rOJ1S5GY63YTzaaj0-bxLh3o1YMyIra7bHzlvxvtKNU6dihUKAMZdDMBKgvcblGTPDgaB4L9ruf4Sk";

export const authenticatedAxios = axios.create({
  baseURL: CMS_BASE_API_URL,
  headers: {
    "Cookie": `UserSessionID=${USER_SESSION_ID}`,
    "Accept": "application/json"
  }
});
