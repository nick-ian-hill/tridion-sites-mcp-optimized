import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const getPublications = {
    name: "getPublications",
    description: `Retrieves a list of all Publications in the Content Management System.
  Since the Title property of a Publication must be unique, this tool can be used to lookup the TCM URI of a Publication when only the Title is known.
  For this use case, the tool should be used with the 'details' level set to 'IdAndTitleOnly' since additional data is not required.`,
    input: {
        details: z.enum(["IdAndTitleOnly", "WithApplicableActions", "Contentless"]).optional().default("IdAndTitleOnly").describe("Specifies the level of detail for the returned publications. Contentless returns the most detail. If full details of an individual Publication are required, it should be obtained using getItemById."),
    },
    execute: async ({ details }: { details?: "IdAndTitleOnly" | "WithApplicableActions" | "Contentless" }) => {
        try {
            const response = await authenticatedAxios.get('/publications', {
                params: { details }
            });

            if (response.status === 200) {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(response.data, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to retrieve publications");
        }
    }
};