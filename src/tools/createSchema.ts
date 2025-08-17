import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";
import { toLinkArray } from "../utils/links.js";

export const createSchema = {
    name: "createSchema",
    description: "Creates a new Content Manager System (CMS) item of type 'Schema'. Schemas define the structure of content and metadata for other CMS items.",
    input: {
        title: z.string().describe("The title for the new Schema."),
        locationId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).describe("The TCM URI of the parent Folder where the new Schema will be created."),
        purpose: z.enum([
            "Component", "Multimedia", "Embedded",
            "Metadata", "Bundle", "Region"
        ]).describe("The purpose of the Schema, which determines where it can be used."),
        rootElementName: z.string().describe("The name of the root element for the XML structure defined by the Schema."),
        description: z.string().optional().describe("An optional description for the Schema."),
        namespaceUri: z.string().optional().describe("The namespace URI (target namespace) of the Schema."),
        fields: z.string().optional().describe("An XML string defining the content fields of the Schema, compliant with XSD 1.0. This is used for 'Component' and 'Embedded' purpose Schemas. When creating a text field where the values are provided by a Category (i.e., where the values are keywords), the Category must be specified. It is therefore recommended to create the Category before creating the Schema."),
        metadataFields: z.string().optional().describe("An XML string defining the metadata fields of the Schema, compliant with XSD 1.0."),
        allowedMultimediaTypes: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).optional().describe("An array of TCM URIs for allowed Multimedia Types. Only applicable when 'purpose' is 'Multimedia'."),
        bundleProcessId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).optional().describe("The TCM URI of a Process Definition to associate as the Bundle Process."),
        componentProcessId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).optional().describe("The TCM URI of a Process Definition to associate as the Component Process for workflow."),
        deleteBundleOnProcessFinished: z.boolean().optional().describe("If true, Bundles based on this Schema will be deleted when their workflow process finishes. Only applicable when 'purpose' is 'Bundle'."),
        isIndexable: z.boolean().optional().describe("Specifies whether Components based on this Schema will be indexed for searching."),
        isPublishable: z.boolean().optional().describe("Specifies whether Components based on this Schema can be resolved for data publishing."),
        regionDefinition: z.string().optional().describe("The Region Definition for the Schema. Only applicable when 'purpose' is 'Region'.")
    },
    execute: async (args: any) => {
        const {
            title, locationId, purpose, rootElementName, description, namespaceUri,
            fields, metadataFields, allowedMultimediaTypes, bundleProcessId,
            componentProcessId, deleteBundleOnProcessFinished, isIndexable,
            isPublishable, regionDefinition
        } = args;

        // Validation for purpose-specific fields
        if (purpose !== 'Multimedia' && allowedMultimediaTypes) {
            return { content: [], errors: [{ message: "'allowedMultimediaTypes' can only be set when the Schema 'purpose' is 'Multimedia'." }] };
        }
        if (purpose !== 'Bundle' && typeof deleteBundleOnProcessFinished === 'boolean') {
            return { content: [], errors: [{ message: "'deleteBundleOnProcessFinished' can only be set when the Schema 'purpose' is 'Bundle'." }] };
        }
        if (purpose !== 'Region' && regionDefinition) {
            return { content: [], errors: [{ message: "'regionDefinition' can only be set when the Schema 'purpose' is 'Region'." }] };
        }

        try {
            // 1. Get the default model for the Schema type
            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Schema', {
                params: { containerId: locationId }
            });
            
            if (defaultModelResponse.status !== 200) {
                return { content: [], errors: [{ message: `Failed to retrieve default model. Status: ${defaultModelResponse.status}, Message: ${defaultModelResponse.statusText}` }] };
            }
            
            const payload = defaultModelResponse.data;
            
            // 2. Customize the payload with provided arguments
            payload.Title = title;
            payload.Purpose = purpose;
            payload.RootElementName = rootElementName;
            
            if (description) payload.Description = description;
            if (namespaceUri) payload.NamespaceUri = namespaceUri;
            if (fields) payload.Fields = fields;
            if (metadataFields) payload.MetadataFields = metadataFields;

            if (allowedMultimediaTypes) payload.AllowedMultimediaTypes = toLinkArray(allowedMultimediaTypes);
            if (bundleProcessId) payload.BundleProcess = { "$type": "Link", "IdRef": bundleProcessId };
            if (componentProcessId) payload.ComponentProcess = { "$type": "Link", "IdRef": componentProcessId };

            if (typeof deleteBundleOnProcessFinished === 'boolean') payload.DeleteBundleOnProcessFinished = deleteBundleOnProcessFinished;
            if (typeof isIndexable === 'boolean') payload.IsIndexable = isIndexable;
            if (typeof isPublishable === 'boolean') payload.IsPublishable = isPublishable;

            if (regionDefinition) payload.RegionDefinition = regionDefinition;
            
            if (!payload.LocationInfo?.OrganizationalItem?.IdRef) {
                payload.LocationInfo = { ...payload.LocationInfo, OrganizationalItem: { IdRef: locationId } };
            }

            // 3. Post the customized payload to create the Schema
            const createResponse = await authenticatedAxios.post('/items', payload);

            if (createResponse.status === 201) {
                return {
                    content: [{
                        type: "text",
                        text: `Successfully created Schema with ID ${createResponse.data.Id}.\n\n${JSON.stringify(createResponse.data, null, 2)}`
                    }],
                };
            } else {
                return {
                    content: [],
                    errors: [{ message: `Unexpected response status during Schema creation: ${createResponse.status}` }],
                };
            }

        } catch (error) {
            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `API Error Status ${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to create Schema: ${errorMessage}` }],
            };
        }
    }
};