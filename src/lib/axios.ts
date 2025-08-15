import axios from "axios";

// CMS API base and UserSessionID cookie
const CMS_BASE_API_URL = "http://10.100.92.199:81/ui/api/v3.0";
const USER_SESSION_ID = "CfDJ8MFdR0UUsZtPi5oTnQ5q67LCnIHTVL40uSySitkCCkqYkD7xtDCAVVjMDKEFtGdUtN3zw0deUrkniyzjR334A7dWDEoCavVN6T8pjjR11UjT1Fuk5zl8CVMZqhmG7sZKCkO85GrTkJIDGQSLL2fRF52tdDgtjCxCFJUtkcscP_NuKu1xoNcHAci_RmVs6ZrSCNfknMerZOnBiai_uvUlPYvycbV7Eql4iApNFGWt2pegP-ArPXA6N2kIER_7NadE50EH78qY8vKMper1VwSLe923HJyiW8sYf2u1wZaEOKcmL3E6h0dcHwkvpwY4o5mcvidbd2WcqMrmfToEFlWZGQM";

export const authenticatedAxios = axios.create({
  baseURL: CMS_BASE_API_URL,
  headers: {
    "Cookie": `UserSessionID=${USER_SESSION_ID}`,
    "Accept": "application/json"
  }
});
