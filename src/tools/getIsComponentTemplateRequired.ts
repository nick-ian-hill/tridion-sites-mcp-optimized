import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const getIsComponentTemplateRequired = {
    name: "getIsComponentTemplateRequired",
    description: `Checks if a Component Template is mandatory when creating a Component Presentation. This is important for understanding which publishing model the system is configured for: the legacy 'template-based' model or the modern 'templateless, data-only' model.
In the template-based model, a Component Template must be combined with a Component to create a 'Component Presentation,' which controls how content looks and behaves. In the templateless model, no Component Template is required, and there is no concept of a Component Presentation.
This is a crucial check before using the 'createPage' or 'updatePage' tools. If this tool returns true, the 'componentPresentations' parameter for those tools must contain objects with both a 'Component' and a 'ComponentTemplate'. If false, the 'ComponentTemplate' is optional.`,
    input: {},
    execute: async (_: {}, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const response = await authenticatedAxios.get('/system/capabilities');

            if (response.status === 200) {
                const capabilities = response.data;
                const enabledFeatures = capabilities.EnabledFeatures || [];
                
                const isRequired = enabledFeatures.includes("DisableDataPipeline");
                
                const message = isRequired
                    ? "A Component Template is mandatory for Component Presentations because data-only publishing is disabled."
                    : "A Component Template is not mandatory for Component Presentations because data-only publishing is enabled.";

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            isComponentTemplateRequired: isRequired,
                            message: message
                        }, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to retrieve system capabilities");
        }
    }
};