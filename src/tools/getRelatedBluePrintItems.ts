import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

const getRelatedBluePrintItemsInputProperties = {
    itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)
        .describe("The TCM URI of the item or Publication to analyze."),
    
    relationship: z.enum([
        "Child", 
        "Descendant", 
        "Parent", 
        "Ancestor", 
        "Sibling", 
        "LocalizedIn", 
        "SharedIn"
    ]).describe("The relationship filter. \n- 'Child'/'Parent': Immediate connections.\n- 'Descendant'/'Ancestor': Recursive connections.\n- 'LocalizedIn': Descendant locations where the item has been edited (broken inheritance).\n- 'SharedIn': Descendant locations where the item is visible as a read-only shared item."),
    
    itemTypeFilter: z.enum([
        "Publication", "StructureGroup", "Folder", "Component", 
        "Page", "Schema", "Template", "Category", "Keyword"
    ]).optional()
        .describe("Optional. Only return items of this specific type. Useful when analyzing a Publication's hierarchy but you only want to see the related Publications, not the root items within them.")
};

const getRelatedBluePrintItemsSchema = z.object(getRelatedBluePrintItemsInputProperties);

export const getRelatedBluePrintItems = {
    name: "getRelatedBluePrintItems",
    description: `Retrieves a specific set of related BluePrint items based on their relationship to the input item.
This tool simplifies BluePrint navigation by returning flat lists of items rather than complex graphs.

Use Cases:
- Use 'Child' to find immediate sub-publications.
- Use 'Descendant' for full impact analysis (finding all items that inherit from this one).
- Use 'LocalizedIn' to find where inheritance has been broken (the item was edited locally).
- Use 'SharedIn' to find where the item is being used exactly as it is in the parent.

Example:
// Find all locations where the component "tcm:5-123" has been localized (edited).
const result = await tools.getRelatedBluePrintItems({
    itemId: "tcm:5-123",
    relationship: "LocalizedIn"
});

Expected JSON Output:
[
  {
    "Id": "tcm:12-123",
    "Title": "About Us (Local)",
    "PublicationTitle": "100 Master Content",
    "IsLocalized": true
  },
  {
    "Id": "tcm:14-123",
    "Title": "About Us (Fr)",
    "PublicationTitle": "200 FR Content",
    "IsLocalized": true
  }
]`,
    input: getRelatedBluePrintItemsInputProperties,
    execute: async (input: z.infer<typeof getRelatedBluePrintItemsSchema>, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId, relationship, itemTypeFilter } = input;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedItemId = itemId.replace(':', '_');
            
            // We need basic details + BluePrintInfo to determine localization status
            const response = await authenticatedAxios.get(`/items/${escapedItemId}/bluePrintHierarchy`, {
                params: { details: 'IdAndTitleOnly' }
            });

            if (response.status !== 200) {
                return handleUnexpectedResponse(response);
            }

            const rawItems = response.data.Items; // The hierarchy nodes
            
            // 1. Build the Graph in Memory
            // We map Publication IDs to their Hierarchy Node
            const nodeMap = new Map<string, any>();
            const childrenMap = new Map<string, Set<string>>();
            const parentsMap = new Map<string, Set<string>>();
            
            let contextPubId = "";

            // First pass: Index all nodes
            for (const node of rawItems) {
                const pubId = node.ContextRepositoryId;
                nodeMap.set(pubId, node);
                
                // Identify the node corresponding to the requested input item
                // The API usually marks the context item with a flag, or we check the Item.Id
                // However, for BluePrint hierarchy of an ITEM, the Item.Id changes per line.
                // We identify the "current" node by checking if the Item.Id matches the requested itemId (ignoring pub id) 
                // OR if it's the exact same string if it's a Publication.
                
                // Ideally, the "Input" node is the one where the item exists. 
                // Since the API returns the hierarchy *relative* to the input, we need to find "Self".
                // But specifically for 'Child/Parent' logic relative to the *BluePrint structure*,
                // we need to find the Publication of the `itemId`.
                
                // Extract publication ID from the input Item ID
                const uriMatch = itemId.match(/tcm:(\d+)-/);
                const inputPubId = uriMatch ? `tcm:0-${uriMatch[1]}-1` : "";
                
                if (pubId === inputPubId) {
                    contextPubId = pubId;
                }

                if (!childrenMap.has(pubId)) childrenMap.set(pubId, new Set());
                if (!parentsMap.has(pubId)) parentsMap.set(pubId, new Set());
            }

            // Second pass: Build relationships
            for (const node of rawItems) {
                const childPubId = node.ContextRepositoryId;
                if (node.Parents) {
                    for (const parent of node.Parents) {
                        const parentPubId = parent.IdRef;
                        
                        // Register Parent -> Child
                        if (!childrenMap.has(parentPubId)) childrenMap.set(parentPubId, new Set());
                        childrenMap.get(parentPubId)!.add(childPubId);

                        // Register Child -> Parent
                        parentsMap.get(childPubId)!.add(parentPubId);
                    }
                }
            }

            if (!contextPubId && rawItems.length > 0) {
                // Fallback: If we couldn't match the pub ID exactly (e.g. ECL item), 
                // we might need another strategy. But for standard TCM logic:
                // If itemId is a publication, it matches.
                // If itemId is an item, we extracted its pubId.
                // If the graph is empty, we return empty.
                // If the graph has items but we can't find "self", something is wrong with the parsing.
                // For now, let's assume the inputPubId derivation works.
            }

            // 2. Traverse based on Relationship
            const resultPubIds = new Set<string>();

            const getDescendants = (startPubId: string, visited: Set<string>) => {
                const children = childrenMap.get(startPubId);
                if (children) {
                    for (const child of children) {
                        if (!visited.has(child)) {
                            visited.add(child);
                            resultPubIds.add(child);
                            getDescendants(child, visited);
                        }
                    }
                }
            };

            const getAncestors = (startPubId: string, visited: Set<string>) => {
                const parents = parentsMap.get(startPubId);
                if (parents) {
                    for (const parent of parents) {
                        if (!visited.has(parent)) {
                            visited.add(parent);
                            resultPubIds.add(parent);
                            getAncestors(parent, visited);
                        }
                    }
                }
            };

            switch (relationship) {
                case "Child":
                    childrenMap.get(contextPubId)?.forEach(id => resultPubIds.add(id));
                    break;
                case "Descendant":
                case "LocalizedIn":
                case "SharedIn":
                    getDescendants(contextPubId, new Set());
                    break;
                case "Parent":
                    parentsMap.get(contextPubId)?.forEach(id => resultPubIds.add(id));
                    break;
                case "Ancestor":
                    getAncestors(contextPubId, new Set());
                    break;
                case "Sibling":
                    // Siblings = Children of my Parents, excluding Me.
                    const myParents = parentsMap.get(contextPubId);
                    if (myParents) {
                        for (const parentId of myParents) {
                            const siblings = childrenMap.get(parentId);
                            if (siblings) {
                                siblings.forEach(sib => {
                                    if (sib !== contextPubId) resultPubIds.add(sib);
                                });
                            }
                        }
                    }
                    break;
            }

            // 3. Filter and Format Results
            let finalItems = [];

            for (const pubId of resultPubIds) {
                const node = nodeMap.get(pubId);
                if (!node) continue;

                const item = node.Item;
                
                // --- State-Based Filtering (LocalizedIn / SharedIn) ---
                if (relationship === "LocalizedIn") {
                    const isLocalized = item.BluePrintInfo?.IsLocalized === true;
                    if (!isLocalized) continue;
                }
                if (relationship === "SharedIn") {
                    const isShared = item.BluePrintInfo?.IsShared === true;
                    const isLocalized = item.BluePrintInfo?.IsLocalized === true;
                    if (!isShared || isLocalized) continue; // Must be shared AND not localized
                }

                // --- Item Type Filtering ---
                // If the user requested specific item types, filter here.
                // Note: If the graph is for a Component, 'item' is the Component.
                // If the graph is for a Publication, 'item' IS the Publication.
                if (itemTypeFilter) {
                    // Check the type of the item found in the hierarchy node
                    // But wait: if I ask for "Child" of a "Component", I usually expect the *Component* in the child publication.
                    // If I filter by "Publication", I want the *Publication object*.
                    // The API returns the context item in `node.Item`.
                    
                    // Special Case: If filtering by "Publication", we construct the object from the Node info
                    if (itemTypeFilter === "Publication") {
                        finalItems.push({
                            Id: node.ContextRepositoryId,
                            Title: node.ContextRepositoryTitle,
                            type: "Publication",
                            PublicationId: node.ContextRepositoryId,
                            PublicationTitle: node.ContextRepositoryTitle
                        });
                        continue; 
                    } else if (item.$type !== itemTypeFilter && item.type !== itemTypeFilter) {
                        continue;
                    }
                }

                // Default Output Format
                // We return a simplified object
                finalItems.push({
                    Id: item.Id,
                    Title: item.Title,
                    type: item.$type || "Unknown",
                    PublicationId: node.ContextRepositoryId,
                    PublicationTitle: node.ContextRepositoryTitle,
                    IsLocalized: item.BluePrintInfo?.IsLocalized || false,
                    IsShared: item.BluePrintInfo?.IsShared || false
                });
            }

            // Clean up for agent
            const formattedData = formatForAgent(finalItems);

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(formattedData, null, 2)
                }]
            };

        } catch (error) {
            return handleAxiosError(error, `Failed to retrieve related BluePrint items for ${itemId}`);
        }
    }
};