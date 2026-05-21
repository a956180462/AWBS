export const AWBS_DIR = ".awbs";
export const INDEX_PATH = ".awbs/index/files.sqlite";
export const LEGACY_INDEX_PATH = ".awbs/index/files.jsonl";
export const SUMMARY_PATH = ".awbs/summaries/files.jsonl";
export const VIEW_MANIFEST = ".awbs-view.json";
export const TRUSTED_REF = "refs/awbs/trusted";

export const INDEX_EXCLUDED_PATHS = [
  ".git",
  "node_modules",
  ".awbs/index",
  ".awbs/summaries",
  ".awbs/views",
  ".awbs/changesets",
  ".awbs/private"
];
