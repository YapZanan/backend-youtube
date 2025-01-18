import { isPlainObject } from "lodash";

const D1_MAX_PARAMETERS = 100; // Cloudflare D1's SQL variable limit

/**
 * Automatically chunks items into smaller batches to avoid exceeding D1's SQL variable limit.
 * @param items - The items to process in chunks.
 * @param cb - The callback function to process each chunk.
 * @param otherParametersCount - Additional parameters in the query (e.g., WHERE clauses).
 * @returns A flattened array of results from processing all chunks.
 */
export const autochunk = async <
    T extends Record<string, unknown> | string | number,
    U,
>(
    items: T[],
    cb: (chunk: T[]) => Promise<U[]>,
    otherParametersCount: number = 0,
): Promise<U[]> => {
    const chunks: T[][] = [];

    let chunk: T[] = [];
    let chunkParameters = 0;

    if (otherParametersCount > D1_MAX_PARAMETERS) {
        throw new Error(
            `otherParametersCount cannot be more than ${D1_MAX_PARAMETERS}`,
        );
    }

    for (const item of items) {
        const itemParameters = isPlainObject(item) ? Object.keys(item).length : 1;

        if (itemParameters > D1_MAX_PARAMETERS) {
            throw new Error(`Item has too many parameters (${itemParameters})`);
        }

        if (
            chunkParameters + itemParameters + otherParametersCount >
            D1_MAX_PARAMETERS
        ) {
            chunks.push(chunk);
            chunkParameters = itemParameters;
            chunk = [item];
            continue;
        }

        chunk.push(item);
        chunkParameters += itemParameters;
    }

    if (chunk.length) {
        chunks.push(chunk);
    }

    const results: U[][] = [];

    for (const chunk of chunks) {
        const result = await cb(chunk);
        results.push(result);
    }

    return results.flat();
};