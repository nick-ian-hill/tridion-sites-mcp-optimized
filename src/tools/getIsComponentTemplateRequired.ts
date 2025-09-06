import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const getIsComponentTemplateRequired = {
    name: "getIsComponentTemplateRequired",
    description: `Checks the system capabilities to determine if a Component Template is mandatory when creating a Component Presentation. This is important for understanding which publishing model the system is configured for: the legacy 'template-based' model or the modern 'templateless, data-only' model.

In the template-based model, a Component Template must be combined with a Component to create a 'Component Presentation,' which controls how content looks and behaves. In the templateless model, no Component Template is required, and there is no concept of a Component Presentation.

The result of this tool is crucial for using the createPage tool correctly. If this tool returns true, it indicates a template-based model, and the 'componentPresentations' parameter of the createPage tool must contain objects with both a 'Component' and a 'ComponentTemplate'. If it returns false, it indicates a templateless or hybrib model where Component Presentations are optional.`,
    input: {},
    execute: async () => {
        try {
            const response = await authenticatedAxios.get('/system/capabilities');

            if (response.status === 200) {
                const capabilities = response.data;
                const enabledFeatures = capabilities.EnabledFeatures || [];
                
                // If "DisableDataPipeline" is enabled, a Component Template is mandatory.
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
