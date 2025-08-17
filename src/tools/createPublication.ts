import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";
import { toLinkArray } from "../utils/links.js";

export const createPublication = {
    name: "createPublication",
    description: `Creates a new Publication.
    Publications are the main organizational units in the Content Management System. They act as containers for all other content and design items like Components, Pages, and Schemas.
    Publications are central to the concept of BluePrinting, a powerful feature that allows for content reuse and inheritance across a hierarchy of Publications.
    Only Publications with a root Structure Group can have child Publications.
    A structure consisting of one or more child Publications is known as a BluePrint hierarchy.
    A BluePrint hierarchy has a single root Publication, that is, a single Publication with no parent.
    A child Publication inherits content from its parent Publications.
    BluePrint hierarchies are ideal for managing multi-language websites, different brand channels, or various stages of a project (like development, staging, and live).
    
    When a Publication has multiple parents, specific rules govern item inheritance conflicts:
    1.  **Proximity Rule**: If an item exists in multiple parent paths, the child inherits from the closest parent (fewest hops) that contains a localized or original version of that item, not a shared one.
    2.  **Priority Rule (Tie-Breaker)**: If multiple parents are equally close, the one with the highest priority is chosen. Priority is determined by the order in the 'parentPublications' array; the Publication with the lowest index has the highest priority.`,
    input: {
        title: z.string().describe("The title for the new Publication."),
        parentPublications: z.array(z.string().regex(/^tcm:\d+-\d+-1$/)).optional().describe("An array of URIs for parent Publications. If no parent Publications are specified, a root Publication will be created. Given two parents, the parent with the lower index has the higher priority. This can be relevant when determining from which parent an item is inherited."),
        publicationKey: z.string().optional().describe("The publication key, which can be used as an additional unique identifier for a Publication. If not specified, the Publication title will used."),
        //publicationPath: z.string().optional().describe("The publication path, which forms the base of the publish path for Structure Groups and Pages within this Publication."),
        //publicationUrl: z.string().optional().describe("The server-relative URL for the Publication. This will be prefixed to the URLs of published Pages."),
        //multimediaPath: z.string().optional().describe("The physical path on the server where multimedia binaries will be published."),
        //multimediaUrl: z.string().optional().describe("The URL that corresponds to the Multimedia Path, used to construct links to published multimedia."),
        locale: z.string().optional().describe("The locale for the Publication (e.g., 'en-US', 'de-DE')."),
        publicationType: z.string().optional().describe("The type of the Publication (e.g., 'Web', 'Content'). Use the getPublicationTypes tool to see the available types.")
    },
    examples: [
        {
            input: {
                title: "My New Website Publication",
                parentPublications: ['tcm:0-5-1'],
                publicationUrl: "/my-new-site",
                multimediaUrl: "/my-new-site/images",
                locale: "en-US"
            },
            description: "Creates a new child Publication with a title, a publication URL for web content, a specific URL for multimedia items, and sets its locale to US English."
        },
        {
            input: {
                title: "Corporate Master Content",
                publicationType: "Content"
            },
            description: "Creates a basic 'Content' Publication intended to be a parent in a BluePrint structure, from which other Publications can inherit content."
        }
    ],
    execute: async (args: any) => {
        const {
            title, parentPublications, publicationKey, publicationPath,
            publicationUrl, multimediaPath, multimediaUrl, locale, publicationType
        } = args;

        try {
            // 1. Get the default model for a Publication
            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Publication');

            if (defaultModelResponse.status !== 200) {
                return {
                    content: [],
                    errors: [{ message: `Failed to retrieve default model for Publication. Status: ${defaultModelResponse.status}, Message: ${defaultModelResponse.statusText}` }]
                };
            }

            const payload = defaultModelResponse.data;

            // 2. Customize the payload with the provided arguments
            payload.Title = title;
            if (publicationKey) payload.Key = publicationKey;
            if (publicationPath) payload.PublicationPath = publicationPath;
            if (publicationUrl) payload.PublicationUrl = publicationUrl;
            if (multimediaPath) payload.MultimediaPath = multimediaPath;
            if (multimediaUrl) payload.MultimediaUrl = multimediaUrl;
            if (locale) payload.Locale = locale;
            if (publicationType) payload.PublicationType = publicationType;
            if (parentPublications) payload.Parents = toLinkArray(parentPublications);

            // 3. Post the customized payload to create the Publication
            const createResponse = await authenticatedAxios.post('/items', payload);

            if (createResponse.status === 201) {
                return {
                    content: [{
                        type: "text",
                        text: `Successfully created Publication with ID ${createResponse.data.Id}.\n\n${JSON.stringify(createResponse.data, null, 2)}`
                    }],
                };
            } else {
                return {
                    content: [],
                    errors: [{ message: `Unexpected response status during Publication creation: ${createResponse.status}` }],
                };
            }

        } catch (error) {
            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `API Error Status ${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to create Publication: ${errorMessage}` }],
            };
        }
    }
};