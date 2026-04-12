import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

const getRelatedBluePrintItemsInputProperties = {
    itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[^:\s]+)$/)
        .describe("The TCM URI of the item or Publication to analyze."),
    
    relationship: z.enum([
        // Publication Structure Relationships
        "Child", 
        "Descendant", 
        "Parent", 
        "Ancestor", 
        "Sibling", 
        // Item Inheritance Relationships
        "LocalizedIn", 
        "SharedIn",
        "SharedFrom",
        "LocalizedFrom",
        "PrimaryItem",
        "InheritancePath"
    ]).describe(`The relationship filter.
    - 'Child'/'Descendant': Publications that inherit from the specified Publication. (Requires a Publication ID).
    - 'Parent'/'Ancestor': Publications that the specified Publication inherits from. (Requires a Publication ID).
    - 'Sibling': Publications that share the same parent(s). (Requires a Publication ID).
    - 'LocalizedIn': Descendant locations where this item exists as a Localized (editable) copy.
    - 'SharedIn': Descendant locations where this item exists as a Shared (read-only) copy.
    - 'SharedFrom': The immediate parent item(s) from which this item inherits (valid for Shared items).
    - 'LocalizedFrom': The immediate parent item(s) from which this item *would* inherit if it were not localized (valid for Localized items).
    - 'PrimaryItem': The original root item (Owning Item) in the hierarchy.
    - 'InheritancePath': The full upward chain of items from the current item to the Primary Item. Returns an ordered list [Self, Parent, Grandparent...].`)
};

const getRelatedBluePrintItemsSchema = z.object(getRelatedBluePrintItemsInputProperties);

export const getRelatedBluePrintItems = {
    name: "getRelatedBluePrintItems",
    summary: "Lists related items in the BluePrint (Children, Parents, Ancestors, Localized/Shared copies).",
    description: `Retrieves related items within the BluePrint hierarchy based on a specific relationship.
    Note: If the user asks for a visual diagram, image, or full graph structure, use 'getBluePrintHierarchy' instead.

**Return Formats:**
1. **For Publication Structure (itemId is a Publication):**
   Returns a list of Publications.
   [{ "Id": "tcm:0-5-1", "Title": "100 Master", "type": "Publication" }]

2. **For Item Inheritance (itemId is a Content Item):**
   Returns an array of objects containing Item context and State.
   {
     "Item": { "Id": "...", "Title": "...", "type": "..." },
     "Publication": { "Id": "...", "Title": "..." },
     "State": "Localized" | "Shared" | "Primary"
   }

**Logic & Priority:**
This tool relies on the CMS to resolve BluePrint priority and proximity. The results reflect the *effective* inheritance path. 

**Use Cases:**
- **Impact Analysis:** Use 'SharedIn' and 'LocalizedIn' to see exactly where a change to the current item will propagate.
- **Origin Tracing:** Use 'SharedFrom' or 'LocalizedFrom' to find the immediate source of the current item. For example, when wanting to check whether the item the current item is localized from was modified more recently than the localied item.
- **Root Cause:** Use 'PrimaryItem' to find the master copy of the content. Any non-localizable fields will always inherit their values from the PrimaryItem.
- **Debugging:** Use 'InheritancePath' to trace the exact lineage of an item to understand where properties are inherited from.
- **Publication Navigation:** Use 'Child'/'Parent' (with a Publication ID) to navigate the repository structure.

### Example 1: Publication Ancestors
// Find all ancestors of Publication "tcm:0-12-1"
const result = await tools.getRelatedBluePrintItems({
    itemId: "tcm:0-12-1",
    relationship: "Ancestor"
});

// Expected JSON Output:
[
  { "Id": "tcm:0-5-1", "Title": "100 Master Content", "type": "Publication" },
  { "Id": "tcm:0-1-1", "Title": "000 Empty Root", "type": "Publication" }
]

### Example 2: Item Impact Analysis
// Find all publications where "tcm:5-123" has been localized.
const result = await tools.getRelatedBluePrintItems({
    itemId: "tcm:5-123",
    relationship: "LocalizedIn"
});

// Expected JSON Output:
[
  {
    "Item": { "Id": "tcm:12-123", "Title": "About Us (Local)", "type": "Component" },
    "Publication": { "Id": "tcm:0-12-1", "Title": "400 Website DE" },
    "State": "Localized"
    },
  {
    "Item": { "Id": "tcm:14-123", "Title": "About Us (FR)", "type": "Component" },
    "Publication": { "Id": "tcm:0-14-1", "Title": "400 Website FR" },
    "State": "Localized"
  }
]

### Example 3: Inheritance Path (Upstream)
// Trace the path of an item up to its Primary item.
const result = await tools.getRelatedBluePrintItems({
    itemId: "tcm:12-123",
    relationship: "InheritancePath"
});

// Expected JSON Output:
[
  {
    "Item": { "Id": "tcm:12-123", "Title": "About Us (Local)", "type": "Component" },
    "Publication": { "Id": "tcm:0-12-1", "Title": "400 Website DE" },
    "State": "Localized"
  },
  {
    "Item": { "Id": "tcm:5-123", "Title": "About Us", "type": "Component" },
    "Publication": { "Id": "tcm:0-5-1", "Title": "100 Master Content" },
    "State": "Primary"
  }
]`,
    input: getRelatedBluePrintItemsInputProperties,
    execute: async (input: z.infer<typeof getRelatedBluePrintItemsSchema>, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId, relationship } = input;

        try {
            // --- Validation Logic ---
            const publicationOnlyRelationships = new Set(["Child", "Descendant", "Parent", "Ancestor", "Sibling"]);
            const isPublicationId = itemId.endsWith("-1") && itemId.startsWith("tcm:0-"); 

            if (publicationOnlyRelationships.has(relationship) && !isPublicationId) {
                // Assuming standard TCM URI format where Publications end in -1 (e.g., tcm:0-5-1)
                throw new Error(
                    `Validation Error: The relationship '${relationship}' is strictly for navigating Publication structure and requires a Publication ID (e.g., tcm:0-5-1).\n` +
                    `You provided '${itemId}', which appears to be a Content Item.\n` +
                    `To analyze how this item inherits, please use 'SharedIn', 'LocalizedIn', 'SharedFrom', or 'InheritancePath'.`
                );
            }

            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedItemId = itemId.replace(':', '_');
            
            // --- OPTIMIZATION FOR PrimaryItem ---
            // If the user wants the PrimaryItem, we can check the item directly first
            // to avoid the expensive hierarchy traversal if the API provides the link.
            if (relationship === "PrimaryItem" && !isPublicationId) {
                const itemResponse = await authenticatedAxios.get(`/items/${escapedItemId}`, {
                    params: { includeProperties: ["BluePrintInfo"] }
                });
                
                if (itemResponse.status === 200 && itemResponse.data.BluePrintInfo?.PrimaryBluePrintParentItem?.IdRef) {
                    const primaryId = itemResponse.data.BluePrintInfo.PrimaryBluePrintParentItem.IdRef;
                    
                    // We need to fetch the primary item's full details to match the tool's return format
                    const primaryResponse = await authenticatedAxios.get(`/items/${primaryId.replace(':', '_')}`);
                    if (primaryResponse.status === 200) {
                        const item = primaryResponse.data;
                        const pubId = item.LocationInfo?.ContextRepository?.IdRef;
                        const pubTitle = item.LocationInfo?.ContextRepository?.Title;

                        const resultObject = {
                            Item: {
                                Id: item.Id,
                                Title: item.Title,
                                type: item.$type
                            },
                            Publication: {
                                Id: pubId,
                                Title: pubTitle
                            },
                            State: "Primary"
                        };
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify(formatForAgent([resultObject]), null, 2)
                            }]
                        };
                    }
                }
            }

            // --- Standard Hierarchy Traversal ---
            // Fetch hierarchy with Contentless details.
            // We NEED BluePrintInfo to determine IsLocalized/IsShared.
            const response = await authenticatedAxios.get(`/items/${escapedItemId}/bluePrintHierarchy`, {
                params: { details: 'Contentless' } 
            });

            if (response.status !== 200) {
                return handleUnexpectedResponse(response);
            }

            const rawItems = response.data.Items; // Array of BluePrintNodes
            
            // --- 1. Graph Construction ---
            // We map Publication IDs to nodes to facilitate traversal.
            const nodeMap = new Map<string, any>();
            const childrenMap = new Map<string, Set<string>>(); // PubId -> Set<ChildPubId>
            const parentsMap = new Map<string, Set<string>>();  // PubId -> Set<ParentPubId>
            
            let contextPubId = "";

            // Robustly extract the Publication ID from the input Item ID
            let inputPubId = itemId;
            if (itemId.startsWith("tcm:0-") && itemId.endsWith("-1")) {
                // It is already a publication ID (e.g., tcm:0-19-1)
                inputPubId = itemId;
            } else {
                // It is an item ID (e.g., tcm:107-2755), extract the Pub ID (107)
                const uriMatch = itemId.match(/tcm:(\d+)-/);
                if (uriMatch) {
                    inputPubId = `tcm:0-${uriMatch[1]}-1`;
                }
            }

            for (const node of rawItems) {
                const pubId = node.ContextRepositoryId;
                nodeMap.set(pubId, node);
                
                // Identify Context Node
                if (pubId === inputPubId) {
                    contextPubId = pubId;
                }

                if (!childrenMap.has(pubId)) childrenMap.set(pubId, new Set());
                if (!parentsMap.has(pubId)) parentsMap.set(pubId, new Set());
            }

            // Build Edges based on the API response.
            for (const node of rawItems) {
                const childPubId = node.ContextRepositoryId;
                if (node.Parents) {
                    for (const parent of node.Parents) {
                        const parentPubId = parent.IdRef;
                        
                        // Register Relationship
                        if (!childrenMap.has(parentPubId)) childrenMap.set(parentPubId, new Set());
                        childrenMap.get(parentPubId)!.add(childPubId);

                        parentsMap.get(childPubId)!.add(parentPubId);
                    }
                }
            }

            // --- 2. Traversal Logic ---
            const resultPubIds = new Set<string>();

            // Helper: Recursive Downstream
            const traverseDown = (startPubId: string, visited: Set<string>) => {
                const children = childrenMap.get(startPubId);
                if (children) {
                    for (const child of children) {
                        if (!visited.has(child)) {
                            visited.add(child);
                            resultPubIds.add(child);
                            traverseDown(child, visited);
                        }
                    }
                }
            };

            // Helper: Recursive Upstream
            const traverseUp = (startPubId: string, visited: Set<string>) => {
                const parents = parentsMap.get(startPubId);
                if (parents) {
                    for (const parent of parents) {
                        if (!visited.has(parent)) {
                            visited.add(parent);
                            resultPubIds.add(parent);
                            traverseUp(parent, visited);
                        }
                    }
                }
            };

            // Helper: Find Root (Primary) - Fallback logic if API property was missing
            const findRoot = (startPubId: string): string => {
                const parents = parentsMap.get(startPubId);
                if (!parents || parents.size === 0) return startPubId; // No parents, this is root
                
                // In a valid BluePrint for a single item, there is strictly one Primary Parent chain 
                // that leads to the Owning Repository.
                const firstParent = parents.values().next().value;
                
                if (!firstParent) return startPubId;
                
                // Only recurse if the parent is actually part of our known graph
                const parentNode = nodeMap.get(firstParent);
                if (!parentNode || !parentNode.Item) {
                    return startPubId;
                }
                
                return findRoot(firstParent);
            };

            // Helper: Linear Chain Upstream
            const tracePathUp = (startPubId: string) => {
                let current = startPubId;
                resultPubIds.add(current); // Include self

                // Loop until we hit the top
                while(true) {
                    const parents = parentsMap.get(current);
                    if (!parents || parents.size === 0) break;

                    const nextParent = parents.values().next().value;
                    
                    if (!nextParent) break;

                    resultPubIds.add(nextParent);
                    current = nextParent;
                }
            }

            // --- 3. Execute Selection based on Relationship ---
            switch (relationship) {
                // --- Publication Structure ---
                case "Child":
                    childrenMap.get(contextPubId)?.forEach(id => resultPubIds.add(id));
                    break;
                case "Descendant":
                    traverseDown(contextPubId, new Set());
                    break;
                case "Parent":
                    parentsMap.get(contextPubId)?.forEach(id => resultPubIds.add(id));
                    break;
                case "Ancestor":
                    traverseUp(contextPubId, new Set());
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

                // --- Item Inheritance ---
                case "LocalizedIn":
                case "SharedIn":
                    // These look Downstream (Descendants)
                    traverseDown(contextPubId, new Set());
                    break;

                case "SharedFrom":
                case "LocalizedFrom":
                    // These look Upstream (Immediate Parents only)
                    parentsMap.get(contextPubId)?.forEach(id => resultPubIds.add(id));
                    break;

                case "PrimaryItem":
                    const rootPubId = findRoot(contextPubId);
                    resultPubIds.add(rootPubId);
                    break;

                case "InheritancePath":
                    // Returns ordered list [Self, Parent, Grandparent...]
                    tracePathUp(contextPubId);
                    break;
            }

            // --- 4. Filter & Format Results ---
            let finalItems = [];

            for (const pubId of resultPubIds) {
                const node = nodeMap.get(pubId);
                if (!node) continue;

                const item = node.Item;
                
                // CRITICAL SAFETY CHECK: 
                // If the graph contains nodes where the item itself is not accessible or not present in the returned data, skip it.
                if (!item) continue;

                const isLocalized = item.BluePrintInfo?.IsLocalized === true;
                const isShared = item.BluePrintInfo?.IsShared === true;

                // Apply Logic Filter
                let include = true;

                if (relationship === "LocalizedIn") {
                    // Must be downstream AND localized
                    if (!isLocalized) include = false;
                } 
                else if (relationship === "SharedIn") {
                    // Must be downstream AND shared (and not localized masking it)
                    if (!isShared || isLocalized) include = false;
                }
                
                if (include) {
                    const isPublication = item.$type === "Publication" || (item.Id && item.Id.endsWith("-1"));
                    
                    if (isPublication) {
                        // For Publication structure requests, we return a flat list.
                        finalItems.push({
                            Id: item.Id,
                            Title: item.Title,
                            type: "Publication"
                        });
                    } else {
                        // For Item inheritance, we need context (Item + Pub + State)
                        let state: string | undefined = "Primary";
                        if (isLocalized) state = "Localized";
                        else if (isShared) state = "Shared";

                        const resultObject: any = {
                            Item: {
                                Id: item.Id,
                                Title: item.Title,
                                type: item.$type
                            },
                            Publication: {
                                Id: node.ContextRepositoryId,
                                Title: node.ContextRepositoryTitle
                            }
                        };

                        if (state) {
                            resultObject.State = state;
                        }
                        
                        finalItems.push(resultObject);
                    }
                }
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