import { VIEW_MANIFEST } from "./constants.ts";
import { AwbsError } from "./errors.ts";
import { assertSafeRelativePath, isPathUnderAny } from "./paths.ts";

export const RESERVED_DATA_PATHS = [".git", ".awbs", VIEW_MANIFEST] as const;

export function assertUserDataPath(path: string, action: string): void {
  assertSafeRelativePath(path);
  if (!path || path === ".") {
    throw new AwbsError(`Cannot ${action} the database root as a data path.`);
  }
  if (isReservedDataPath(path)) {
    throw new AwbsError(`Cannot ${action} AWBS reserved path: ${path}`);
  }
}

export function assertUserDataPaths(paths: string[], action: string): void {
  for (const path of paths) {
    assertUserDataPath(path, action);
  }
}

export function isReservedDataPath(path: string): boolean {
  const normalized = pathKey(path);
  return RESERVED_DATA_PATHS.some((reserved) => normalized === pathKey(reserved) || normalized.startsWith(`${pathKey(reserved)}/`));
}

export function isPathAllowedByWritePaths(path: string, writePaths: string[]): boolean {
  assertUserDataPath(path, "write");
  assertUserDataPaths(writePaths, "declare write access to");
  return isPathUnderAny(path, writePaths);
}

function pathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
