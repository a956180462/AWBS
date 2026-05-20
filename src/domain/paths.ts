import { isAbsolute, sep } from "node:path";
import { AwbsError } from "./errors.ts";

export function normalizeUserPaths(paths: string[]): string[] {
  return uniquePaths(paths.flatMap((path) => path.split(",")).map((path) => normalizeUserPath(path)).filter(Boolean));
}

export function normalizeUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  assertSafeRelativePath(trimmed);
  return toPosixPath(trimmed.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, ""));
}

export function assertSafeRelativePath(input: string): void {
  const normalized = input.replace(/\\/g, "/");
  if (isAbsolute(input) || normalized.startsWith("/") || normalized.includes("../") || normalized === ".." || normalized.startsWith("../")) {
    throw new AwbsError(`Unsafe path: ${input}`);
  }
}

export function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (!seen.has(path)) {
      seen.add(path);
      result.push(path);
    }
  }
  return result;
}

export function isPathUnderAny(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

export function makeId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}_${random}`;
}

export function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

export function fromPosixPath(path: string): string {
  return path.split("/").join(sep);
}

export function filterIgnoredStatus(status: string, root: string, ignoredRelPaths: string[]): string {
  const normalizedIgnored = ignoredRelPaths.map((path) => path.replace(/\\/g, "/").replace(/\/+$/, "")).filter(Boolean);
  const lines = status.split(/\r?\n/).filter(Boolean);
  const kept = lines.filter((line) => {
    const statusPath = line.slice(3).replace(/\\/g, "/");
    return !normalizedIgnored.some((ignored) => statusPath === ignored || statusPath.startsWith(`${ignored}/`));
  });
  return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}
