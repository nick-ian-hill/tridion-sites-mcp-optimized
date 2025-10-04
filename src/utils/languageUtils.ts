const languageMap = new Map<string, number>([
    ['German', 1031],
    ['English', 1033],
    ['Spanish', 3082],
    ['French', 1036],
    ['Dutch', 1043],
    ['Japanese', 1041],
    ['Chinese', 2052]
]);

const idToNameMap = new Map<number, string>();
languageMap.forEach((id, name) => idToNameMap.set(id, name));

/**
 * Converts a language name to its corresponding ID.
 * @param name The language name (case-insensitive).
 * @returns The language ID, or undefined if not found.
 */
export const getLanguageId = (name: string): number | undefined => {
    // Find the key that matches case-insensitively
    for (const key of languageMap.keys()) {
        if (key.toLowerCase() === name.toLowerCase()) {
            return languageMap.get(key);
        }
    }
    return undefined;
};

/**
 * Converts a language ID to its corresponding name.
 * @param id The language ID.
 * @returns The language name, or undefined if not found.
 */
export const getLanguageName = (id: number): string | undefined => {
    return idToNameMap.get(id);
};

/**
 * Gets a list of available language names.
 * @returns An array of strings with the available language names.
 */
export const getAvailableLanguages = (): string[] => {
    return Array.from(languageMap.keys());
};