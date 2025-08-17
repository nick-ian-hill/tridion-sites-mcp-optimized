/**
 * Represents a link to a Content Manager item.
 */
export interface Link {
  $type: "Link";
  IdRef: string;
  Title?: string;
  Description?: string;
}

/**
 * Creates a minimal Link object for a given item ID, suitable for POST/PUT requests.
 * This is used to create references to other items in the system,
 * such as when setting a default template or linking to a schema.
 * Passing null as the id will create a link to "tcm:0-0-0", which signals the API to remove/unlink an existing reference.
 *
 * @param id - The TCM URI of the item to link to. Pass `null` to remove an existing link. If `undefined`, the function returns `undefined`.
 * @returns A Link object, or undefined if the id is `undefined`.
 */
export const toLink = (id: string | undefined | null): Link | undefined => {
  if (id === undefined) {
    return undefined;
  }
  return {
    $type: "Link",
    IdRef: id === null ? "tcm:0-0-0" : id,
  };
};

/**
 * Creates an array of minimal Link objects from an array of item IDs.
 * This is useful for setting properties that can contain multiple linked items,
 * such as parent Keywords or items in a Bundle.
 *
 * @param ids - An array of TCM URIs.
 * @returns An array of Link objects. Returns an empty array if the input is `null` or an empty array. Returns `undefined` if the input is `undefined`.
 */
export const toLinkArray = (ids: string[] | undefined | null): Link[] | undefined => {
  if (ids === undefined) {
    return undefined;
  }
  if (ids === null || ids.length === 0) {
    return [];
  }
  return ids.map(id => ({
    $type: "Link",
    IdRef: id,
  }));
};