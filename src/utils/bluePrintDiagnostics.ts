import { AxiosInstance, isAxiosError } from "axios";
import { convertItemIdToContextPublication } from "./convertItemIdToContextPublication.js";

// Regex to identify potential TCM URIs in the input
const TCM_REGEX = /^(tcm:\d+-\d+(-\d+)?|ecl:[^:\s]+)$/;

function extractIds(obj: any, ids: Set<string> = new Set()): Set<string> {
    if (!obj) return ids;
    if (typeof obj === 'string') {
        if (TCM_REGEX.test(obj)) ids.add(obj);
    } else if (Array.isArray(obj)) {
        obj.forEach(item => extractIds(item, ids));
    } else if (typeof obj === 'object') {
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) extractIds(obj[key], ids);
        }
    }
    return ids;
}

export async function diagnoseBluePrintError(
    error: any,
    args: any,
    contextId: string,
    axiosInstance: AxiosInstance
): Promise<void> {
    if (!isAxiosError(error)) return;

    const status = error.response?.status;
    if (!status) return;

    // =================================================================================
    // CHECK 1: SIBLING ISOLATION (Trigger on 404 or 400)
    // Referenced item exists elsewhere but not here.
    // =================================================================================
    if (status === 404 || status === 400) {
        const ids = extractIds(args);
        for (const originalId of ids) {
            const mappedId = convertItemIdToContextPublication(originalId, contextId);

            // Skip if no conversion occurred (already context ID)
            if (!mappedId || mappedId === originalId) continue;

            try {
                // 1. Verify it fails in the current context
                try {
                    await axiosInstance.get(`/items/${mappedId.replace(':', '_')}?$select=Id`);
                    continue; 
                } catch (localErr) {
                    // Expected: Item is missing in this context
                }

                // 2. CRITICAL CHECK: Does the ORIGINAL item exist?
                await axiosInstance.get(`/items/${originalId.replace(':', '_')}?$select=Id`);

                // SUCCESS: The original exists, but mapped does not.
                throw new Error(
                    `BluePrint Isolation Error: The item '${originalId}' exists but is NOT visible in the current publication ('${contextId}').\n` +
                    `This typically means '${originalId}' is located in a Sibling or Child Publication, not a Parent.\n` +
                    `Action: You cannot use this item directly. Promote it to a common Parent Publication, or use a different item.`
                );

            } catch (checkError: any) {
                if (checkError.message?.includes("BluePrint Isolation Error")) {
                    throw checkError;
                }
            }
        }
    }

    // =================================================================================
    // CHECK 2: INHERITANCE COLLISION (Trigger on 409 or 400)
    // Trying to create an item that already exists from a parent.
    // =================================================================================
    if (status === 409 || status === 400) {
        const collisionCandidateName = args?.title || args?.name;
        const parentFolderId = args?.folderId || args?.locationId;
        
        let existingItem: any = null;
        
        // Strategy A: Parse ID from Error Message (Most Reliable)
        // Error format example: "Source or sources of conflict: tcm:286-780-2."
        const errorMessage = error.response?.data?.Message || "";
        const conflictMatch = errorMessage.match(/Source or sources of conflict:\s*(tcm:\d+-\d+(?:-\d+)?)/);
        
        if (conflictMatch) {
            const conflictSourceId = conflictMatch[1];
            try {
                // IMPORTANT: The API returns the ID of the *original* item (Parent).
                // We must map this to the *current* context (Child) to check if it's inherited (IsShared).
                const localConflictId = convertItemIdToContextPublication(conflictSourceId, contextId);
                
                const conflictResponse = await axiosInstance.get(`/items/${localConflictId.replace(':', '_')}`);
                existingItem = conflictResponse.data;
            } catch (e) {
                // Swallow error if we can't fetch the conflict item
            }
        } 
        
        // Strategy B: Fallback to listing children (Less Reliable due to pagination/latency)
        if (!existingItem && collisionCandidateName && parentFolderId) {
            try {
                const listResponse = await axiosInstance.get(`/items/\${parentFolderId}/children`);
                const children = listResponse.data?.value || listResponse.data || [];
                existingItem = children.find((child: any) =>
                    child.Title === collisionCandidateName || child.Name === collisionCandidateName
                );
            } catch (e) {
                // Swallow
            }
        }

        if (existingItem && error.response) {
            const bpInfo = existingItem.BluePrintInfo;
            const owningPub = bpInfo?.OwningRepository?.Title || "an ancestor Publication";
            
            // Check context. If IsShared is true, it means the item exists here purely because of inheritance.
            const isPureInherited = bpInfo?.IsShared && !bpInfo?.IsLocalized;

            if (isPureInherited) {
                error.response.data = {
                    "BluePrint Efficiency Warning": `Item '${collisionCandidateName}' already exists via inheritance from '${owningPub}'.`,
                    "Instruction": "STOP: You do NOT need to create this item. It is already available.",
                    "ExistingItemID": existingItem.Id,
                    "Status": "409 Conflict (Inherited)"
                };
            } else if (bpInfo?.IsLocalized) {
                 error.response.data = {
                    "Naming Collision": `Item '${collisionCandidateName}' already exists as a Localized copy from '${owningPub}'.`,
                    "Instruction": "Update the existing item or choose a new name.",
                    "Status": "409 Conflict (Localized)"
                };
            }
        }
    }
}