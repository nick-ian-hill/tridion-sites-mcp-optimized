import { z } from "zod";
import * as fs from 'fs';
import * as path from 'path';
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLinkArray } from "../utils/links.js";
import { handleAxiosError } from "../utils/errorUtils.js";

// --- Internal Validation Schemas ---
const parentRefSchema = z.object({
    Title: z.string()
}).passthrough();

const blueprintNodeSchema = z.object({
    Item: z.object({
        Title: z.string().describe("The title of the publication. Must be unique."),
        Key: z.string().optional().describe("The publication key."),
        PublicationUrl: z.string().optional().describe("Server-relative URL (e.g., '/nl')."),
        PublicationPath: z.string().optional().describe("Physical path on server."),
        MultimediaUrl: z.string().optional(),
        MultimediaPath: z.string().optional(),
        Locale: z.string().optional(),
        PublicationType: z.string().optional(),
        Parents: z.array(parentRefSchema).optional().describe("Array of parent references by Title.")
    }).passthrough()
}).passthrough();

// Flexible schema that accepts strings, objects, or arrays
const blueprintDataSchema = z.union([
    z.string(),
    z.object({ Items: z.array(blueprintNodeSchema) }).passthrough(),
    z.array(blueprintNodeSchema)
]);

// --- Tool Input Properties ---
const createBluePrintHierarchyInputProperties = {
    hierarchyData: blueprintDataSchema.optional().describe(
        `The hierarchy data. This can be a raw JSON string, a parsed JSON array, or the full BlueprintHierarchyResponse object. Use this for manually constructed hierarchies, smaller data sets, or when the MCP server is hosted remotely.`
    ),
    hierarchyFilePath: z.string().optional().describe(
        `The absolute file path to a JSON file containing the hierarchy data (e.g., 'C:\\Users\\name\\blueprint.json'). STRONGLY RECOMMENDED for large hierarchies. 
        Note: This ONLY works if the MCP server is running locally on the same machine as your files. If the MCP server is remote, this will fail and you MUST read the file yourself and pass it via 'hierarchyData'. DO NOT use relative paths.`
    ),
    rootStructureGroupTitle: z.string().default("Root").describe("The title of the Root Structure Group to create. This is automatically applied to the single Publication identified as the Root (having no parents).")
};

const createBluePrintHierarchySchema = z.object(createBluePrintHierarchyInputProperties)
    .refine(data => data.hierarchyData || data.hierarchyFilePath, {
        message: "You must provide either 'hierarchyData' or 'hierarchyFilePath'."
    });

export const createBluePrintHierarchy = {
    name: "createBluePrintHierarchy",
    description: `Creates an entire BluePrint hierarchy of Publications in a single, parallelized operation.
    
    This tool resolves dependencies automatically using 'Title' properties and provisions the hierarchy from top to bottom.
    
    ### Core Operations
    1. **Input Resolution**: Accepts data either directly via 'hierarchyData' or by reading a file via 'hierarchyFilePath'.
    2. **Tiered Batching**: Executes creation in parallel dependency tiers (e.g., all Level 1 items are created simultaneously once the Root is ready), drastically reducing execution time.
    3. **Root Provisioning**: Automatically identifies the **Root Publication** (the one with no parents) and creates a **Root Structure Group** within it.
    4. **Output**: Returns a map of Titles to their newly generated TCM URIs.

    ### Supported Format Structure
    Whether passing data directly or using a file, the structure should match the native BlueprintHierarchyResponse (or just its 'Items' array). Extra metadata like '$type' or 'ApplicableActions' is safely ignored:
    [
        {
            "Item": { "Title": "000 Root", "Parents": [] }
        },
        {
            "Item": { 
                "Title": "010 Schema Master", 
                "Parents": [{ "Title": "000 Root" }] 
            }
        },
        {
            "Item": { 
                "Title": "020 Content Master", 
                "Parents": [{ "Title": "010 Schema Master" }] 
            }
        }
    ]

    ### Example 1: Using a File (Recommended for Cloning/Large Hierarchies)
    If the user asks you to clone a large hierarchy from an attached JSON file, DO NOT parse or pass the JSON data yourself. Just provide the file path:
    
    const result = await tools.createBluePrintHierarchy({
        hierarchyFilePath: "blueprint.json", 
        rootStructureGroupTitle: "Root"
    });

    ### Example 2: Passing Data Directly (For dynamic/small hierarchies)
    If you are generating a hierarchy on the fly, pass the object directly into hierarchyData:

    const result = await tools.createBluePrintHierarchy({
        hierarchyData: generatedHierarchyArray,
        rootStructureGroupTitle: "Root"
    });
    `,
    input: createBluePrintHierarchyInputProperties,
    execute: async (input: z.infer<typeof createBluePrintHierarchySchema>, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { hierarchyData, hierarchyFilePath, rootStructureGroupTitle } = input;
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        const idMap = new Map<string, string>();
        const createdPublications: Record<string, string> = {};

        const pendingNodes = new Map<string, any>();
        const nodeParents = new Map<string, Set<string>>();

        try {
            // --- 0. Resolve & Normalize Input Data ---
            let rawData: any;

            if (hierarchyFilePath) {
                const resolvedPath = path.resolve(hierarchyFilePath);
                if (!fs.existsSync(resolvedPath)) {
                    throw new Error(`File not found at path: ${resolvedPath}`);
                }
                const rawFileContent = fs.readFileSync(resolvedPath, 'utf-8');
                try {
                    rawData = JSON.parse(rawFileContent);
                } catch (e: any) {
                    throw new Error(`Failed to parse JSON from file ${resolvedPath}: ${e.message}`);
                }
            } else if (hierarchyData) {
                if (typeof hierarchyData === 'string') {
                    try {
                        rawData = JSON.parse(hierarchyData);
                    } catch (e: any) {
                        throw new Error(`Failed to parse JSON string provided in hierarchyData: ${e.message}`);
                    }
                } else {
                    rawData = hierarchyData;
                }
            }

            const itemsArray = Array.isArray(rawData) ? rawData : rawData.Items;

            if (!itemsArray || !Array.isArray(itemsArray)) {
                throw new Error("Invalid input: Could not resolve an array of Items from the provided data or file.");
            }

            // --- 1. Initialize Graph Data by Title & Validate Single Root ---
            let rootCount = 0;
            itemsArray.forEach(node => {
                const item = node.Item;
                const title = item.Title;

                if (pendingNodes.has(title)) throw new Error(`Duplicate Publication Title found: ${title}`);

                pendingNodes.set(title, item);

                const parents = new Set<string>();
                if (item.Parents && Array.isArray(item.Parents) && item.Parents.length > 0) {
                    item.Parents.forEach((p: any) => parents.add(p.Title));
                } else {
                    rootCount++;
                }
                nodeParents.set(title, parents);
            });

            if (rootCount !== 1) {
                throw new Error(`A BluePrint hierarchy must have exactly one root publication. Found ${rootCount}.`);
            }

            // Fetch base publication model once to reuse
            const pubModelResponse = await authenticatedAxios.get('/item/defaultModel/Publication');
            const basePubModel = pubModelResponse.data;

            // --- 2. Process Dependency Loop (Tiered Parallelization) ---
            let depthLevel = 0;
            let progressMade = true;

            while (pendingNodes.size > 0 && progressMade) {
                progressMade = false;
                const nodesReadyToCreate: string[] = [];

                for (const [title, _] of pendingNodes) {
                    const parents = nodeParents.get(title)!;
                    let allParentsExist = true;
                    for (const parentTitle of parents) {
                        if (!idMap.has(parentTitle)) {
                            allParentsExist = false;
                            break;
                        }
                    }
                    if (allParentsExist) nodesReadyToCreate.push(title);
                }

                if (nodesReadyToCreate.length > 0) {
                    progressMade = true;

                    const batchPromises = nodesReadyToCreate.map(async (title) => {
                        const nodeData = pendingNodes.get(title)!;
                        const parentsTempTitles = nodeParents.get(title)!;

                        const parentRealIds: string[] = [];
                        parentsTempTitles.forEach(pTitle => parentRealIds.push(idMap.get(pTitle)!));

                        const childPayload = JSON.parse(JSON.stringify(basePubModel));
                        childPayload.Title = nodeData.Title;
                        childPayload.Key = nodeData.Key || nodeData.Title;

                        if (parentRealIds.length > 0) {
                            childPayload.Parents = toLinkArray(parentRealIds);
                        }

                        if (nodeData.PublicationUrl) childPayload.PublicationUrl = nodeData.PublicationUrl;
                        if (nodeData.PublicationPath) childPayload.PublicationPath = nodeData.PublicationPath;
                        if (nodeData.MultimediaUrl) childPayload.MultimediaUrl = nodeData.MultimediaUrl;
                        if (nodeData.MultimediaPath) childPayload.MultimediaPath = nodeData.MultimediaPath;
                        if (nodeData.Locale) childPayload.Locale = nodeData.Locale;
                        if (nodeData.PublicationType) childPayload.PublicationType = nodeData.PublicationType;

                        let newId: string;

                        const createRes = await authenticatedAxios.post('/items', childPayload);
                        if (createRes.status !== 201) throw new Error(`Status ${createRes.status}`);

                        newId = createRes.data.Id;

                        // --- 3. Create Root Structure Group for the Root Publication ---
                        if (parentRealIds.length === 0) {
                            const sgModelRes = await authenticatedAxios.get('/item/defaultModel/StructureGroup', { params: { containerId: newId } });
                            const sgPayload = sgModelRes.data;
                            sgPayload.Title = rootStructureGroupTitle;

                            if (!sgPayload.LocationInfo?.OrganizationalItem?.IdRef) {
                                sgPayload.LocationInfo = {
                                    ...sgPayload.LocationInfo,
                                    OrganizationalItem: { IdRef: newId }
                                };
                            }
                            const sgRes = await authenticatedAxios.post('/items', sgPayload);
                            if (sgRes.status !== 201) throw new Error(`Failed to create Root SG. Status: ${sgRes.status}`);
                        }

                        return { title, id: newId };
                    });

                    const batchResults = await Promise.all(batchPromises);

                    batchResults.forEach(res => {
                        idMap.set(res.title, res.id);
                        createdPublications[res.title] = res.id;
                        pendingNodes.delete(res.title);
                    });

                    depthLevel++;
                }
            }

            if (pendingNodes.size > 0) {
                const remainingIds = Array.from(pendingNodes.keys()).join(", ");
                throw new Error(`Dependency resolution failed. Circular dependency or missing parent. Remaining: ${remainingIds}`);
            }

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        message: `BluePrint Hierarchy created successfully. Provisioned ${Object.keys(createdPublications).length} Publications across ${depthLevel} tiers.`,
                        idMap: createdPublications
                    }, null, 2)
                }]
            };

        } catch (error) {
            return handleAxiosError(error, "Failed to create BluePrint Hierarchy");
        }
    }
};