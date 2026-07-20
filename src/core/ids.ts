import { randomUUID } from "node:crypto";

export const SHORT_UUID_LENGTH = 8;

export function shortUuid(): string {
    return randomUUID().slice(0, SHORT_UUID_LENGTH);
}

export function prefixedShortUuid(prefix: string): string {
    return `${prefix}${shortUuid()}`;
}
