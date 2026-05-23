#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { AwbsError } from "./domain/errors.ts";
import { createDefaultRuntime } from "./runtime.ts";
import { runAuthoritySessionDaemon, runAuthoritySessionRequest } from "./session-entry.ts";

type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string[]>;
};

async function main(): Promise<void> {
  const [, , ...argv] = process.argv;
  if (argv[0] === "__session-daemon") {
    await runAuthoritySessionDaemon();
    return;
  }
  if (argv[0] === "__session-request") {
    await runAuthoritySessionRequest();
    return;
  }

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const [domain, action, ...rest] = argv;
  const parsed = parseArgs(rest);
  const cwd = process.cwd();
  const cliPath = process.argv[1];

  if (domain === "init") {
    const runtime = createDefaultRuntime({ cliPath });
    runtime.usecases.init.initProject(cwd);
    console.log("AWBS project initialized.");
    return;
  }

  if (domain === "index" && action === "rebuild") {
    const runtime = createDefaultRuntime({ cliPath });
    const result = runtime.usecases.index.rebuildIndex(cwd);
    console.log(`Index rebuilt: ${result.active} active, ${result.removed} removed -> ${result.path}`);
    return;
  }

  if (domain === "index" && action === "query") {
    const runtime = createDefaultRuntime({ cliPath });
    const json = parsed.flags.has("json");
    const status = singleFlag(parsed, "status") ?? "active";
    if (!["active", "removed", "all"].includes(status)) {
      throw new AwbsError("--status must be active, removed, or all.");
    }
    const entries = runtime.usecases.index.queryIndex(cwd, parsed.positionals[0] ?? null, { json, status: status as "active" | "removed" | "all" });
    if (json) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      for (const entry of entries) {
        console.log(`${entry.status.padEnd(7)} ${entry.kind.padEnd(9)} ${entry.path} :: ${entry.summary}`);
      }
    }
    return;
  }

  if (domain === "summary" && action === "set") {
    const runtime = createDefaultRuntime({ cliPath });
    const target = parsed.positionals[0];
    if (!target) {
      throw new AwbsError("summary set requires a path.");
    }
    const inlineText = singleFlag(parsed, "text");
    const filePath = singleFlag(parsed, "file");
    if ((inlineText && filePath) || (!inlineText && !filePath)) {
      throw new AwbsError("summary set requires exactly one of --text or --file.");
    }
    const summary = inlineText ?? readFileSync(filePath!, "utf8");
    const entry = runtime.usecases.index.setSummary(cwd, { path: target, summary });
    console.log(`Summary set: ${entry.path}`);
    return;
  }

  if (domain === "summary" && action === "get") {
    const runtime = createDefaultRuntime({ cliPath });
    const target = parsed.positionals[0];
    if (!target) {
      throw new AwbsError("summary get requires a path.");
    }
    const entry = runtime.usecases.index.getSummary(cwd, target);
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(entry, null, 2));
    } else if (entry) {
      console.log(entry.summary);
    } else {
      console.log("No external summary found.");
      process.exitCode = 1;
    }
    return;
  }

  if (domain === "summary" && action === "list") {
    const runtime = createDefaultRuntime({ cliPath });
    const entries = runtime.usecases.index.listSummaries(cwd);
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      for (const entry of entries) {
        console.log(`${entry.path} :: ${entry.summary}`);
      }
    }
    return;
  }

  if (domain === "view" && action === "create") {
    const runtime = createDefaultRuntime({ cliPath, authorityMode: "session", controllerToken: requiredControllerToken(parsed) });
    const out = requiredFlag(parsed, "out");
    const readPaths = multiFlag(parsed, "read");
    const writePaths = multiFlag(parsed, "write");
    const manifest = runtime.usecases.view.createView(cwd, { out, readPaths, writePaths });
    console.log(`View created: ${manifest.viewId}`);
    console.log(`Workspace: ${manifest.workspacePath}`);
    return;
  }

  if (domain === "view" && action === "inspect") {
    const runtime = createDefaultRuntime({ cliPath, authorityMode: "auto" });
    const viewId = parsed.positionals[0];
    if (!viewId) {
      throw new AwbsError("view inspect requires a view id.");
    }
    const result = runtime.usecases.view.inspectView(cwd, viewId);
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`View: ${result.contract.viewId}`);
      console.log(`Status: ${result.catalogView.status}`);
      console.log(`Base commit: ${result.contract.baseCommit}`);
      console.log(`Read: ${result.contract.readPaths.join(", ") || "(none)"}`);
      console.log(`Write: ${result.contract.writePaths.join(", ") || "(none)"}`);
      if (result.catalogView.revokedAt) {
        console.log(`Revoked at: ${result.catalogView.revokedAt}`);
      }
    }
    return;
  }

  if (domain === "view" && action === "revoke") {
    const runtime = createDefaultRuntime({ cliPath, authorityMode: "session", controllerToken: requiredControllerToken(parsed) });
    const viewId = parsed.positionals[0];
    if (!viewId) {
      throw new AwbsError("view revoke requires a view id.");
    }
    runtime.usecases.view.revokeView(cwd, viewId);
    console.log(`View revoked: ${viewId}`);
    return;
  }

  if (domain === "changeset" && action === "collect") {
    const runtime = createDefaultRuntime({ cliPath, authorityMode: "auto" });
    const workspace = requiredFlag(parsed, "workspace");
    const manifest = runtime.usecases.changeset.collectChangeset(cwd, workspace);
    console.log(`Changeset collected: ${manifest.changesetId}`);
    console.log(`Status: ${manifest.status}`);
    console.log(`Added: ${manifest.summary.added}, modified: ${manifest.summary.modified}, deleted: ${manifest.summary.deleted}, violations: ${manifest.summary.violations}`);
    return;
  }

  if (domain === "changeset" && action === "inspect") {
    const runtime = createDefaultRuntime({ cliPath });
    const target = parsed.positionals[0];
    if (!target) {
      throw new AwbsError("changeset inspect requires a changeset path or id.");
    }
    const manifest = runtime.usecases.changeset.inspectChangeset(cwd, target);
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(manifest, null, 2));
    } else {
      console.log(runtime.usecases.changeset.formatChangesetSummary(manifest));
    }
    return;
  }

  if (domain === "changeset" && action === "apply") {
    const runtime = createDefaultRuntime({ cliPath, authorityMode: "session", controllerToken: requiredControllerToken(parsed) });
    const target = parsed.positionals[0];
    if (!target) {
      throw new AwbsError("changeset apply requires a changeset path or id.");
    }
    const adapter = singleFlag(parsed, "adapter") ?? "same-path";
    const result = runtime.usecases.changeset.applyChangeset(cwd, target, adapter);
    if (result.commit) {
      console.log(`Changeset applied: ${result.applied} change(s), commit ${result.commit}`);
    } else {
      console.log("Changeset contained no applicable changes.");
    }
    return;
  }

  if (domain === "ledger" && action === "bootstrap") {
    const runtime = createDefaultRuntime({ cliPath, authorityMode: "session", controllerToken: requiredControllerToken(parsed) });
    const result = runtime.usecases.ledger.bootstrapLedger(cwd);
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Trusted chain bootstrapped: ${result.currentTrustedCommit}`);
      console.log(`Parent: ${result.parentTrustedCommit}`);
      console.log(`Entry: ${result.headEntryId}`);
    }
    return;
  }

  if (domain === "ledger" && (action === "inspect" || action === "verify")) {
    const runtime = createDefaultRuntime({ cliPath, authorityMode: "auto" });
    const report = action === "inspect" ? runtime.usecases.ledger.inspectLedger(cwd) : runtime.usecases.ledger.verifyLedger(cwd);
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(runtime.usecases.ledger.formatLedgerReport(report));
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (domain === "db" && action === "audit") {
    const runtime = createDefaultRuntime({ cliPath, authorityMode: "auto" });
    const report = runtime.usecases.db.auditDatabase(cwd);
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(runtime.usecases.db.formatAuditReport(report));
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (domain === "db" && action === "clean-rebuild") {
    const runtime = createDefaultRuntime({ cliPath });
    const session = runtime.usecases.session.statusSession(cwd);
    if (session.active) {
      throw new AwbsError("Stop the authority session before running db clean-rebuild.");
    }
    const report = runtime.usecases.db.cleanRebuild(cwd);
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(runtime.usecases.db.formatCleanRebuildReport(report));
    }
    return;
  }

  if (domain === "db" && action === "backups" && parsed.positionals[0] === "list") {
    const runtime = createDefaultRuntime({ cliPath });
    const backups = runtime.usecases.db.listBackups(cwd);
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(backups, null, 2));
    } else if (backups.length === 0) {
      console.log("No AWBS database backups found.");
    } else {
      for (const backup of backups) {
        console.log(backup);
      }
    }
    return;
  }

  if (domain === "authority" && action === "session") {
    const runtime = createDefaultRuntime({ cliPath });
    const subaction = parsed.positionals[0];
    if (subaction === "start") {
      if (!parsed.flags.has("control-stdin")) {
        throw new AwbsError("authority session start requires --control-stdin.");
      }
      const result = await runtime.usecases.session.startSession(cwd, readControlInput());
      if (parsed.flags.has("json")) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(runtime.usecases.session.formatStatus(result));
        console.log(`Recovery seal: ${result.recoverySealPath}`);
      }
      return;
    }
    if (subaction === "status") {
      const result = runtime.usecases.session.statusSession(cwd);
      if (parsed.flags.has("json")) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(runtime.usecases.session.formatStatus(result));
      }
      if (result.status === "stale" || result.status === "unavailable") {
        process.exitCode = 1;
      }
      return;
    }
    if (subaction === "stop") {
      if (!parsed.flags.has("control-token-stdin")) {
        throw new AwbsError("authority session stop requires --control-token-stdin.");
      }
      const result = runtime.usecases.session.stopSession(cwd, readControllerTokenFromStdin());
      if (parsed.flags.has("json")) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Authority session stopped. Local restored: ${result.localRestored ? "yes" : "no"}`);
      }
      return;
    }
    if (subaction === "recover") {
      if (!parsed.flags.has("recovery-secret-stdin")) {
        throw new AwbsError("authority session recover requires --recovery-secret-stdin.");
      }
      const result = runtime.usecases.session.recoverSession(cwd, readRecoverySecretFromStdin());
      if (parsed.flags.has("json")) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Authority local material recovered: ${result.recovered ? "yes" : "already present"}`);
      }
      return;
    }
    throw new AwbsError("authority session requires start, status, stop, or recover.");
  }

  if (domain === "authority" && action === "verify") {
    const runtime = createDefaultRuntime({ cliPath, authorityMode: "auto" });
    const report = runtime.usecases.authority.verifyAuthority(cwd);
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(runtime.usecases.authority.formatVerifyReport(report));
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (domain === "authority" && action === "repair-mirrors") {
    const runtime = createDefaultRuntime({ cliPath, authorityMode: "session", controllerToken: requiredControllerToken(parsed) });
    const report = runtime.usecases.authority.repairMirrors(cwd);
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(runtime.usecases.authority.formatRepairReport(report));
    }
    return;
  }

  throw new AwbsError(`Unknown command: ${argv.join(" ")}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const [rawName, inlineValue] = token.slice(2).split("=", 2);
      const values = flags.get(rawName) ?? [];
      if (inlineValue !== undefined) {
        values.push(inlineValue);
      } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
        values.push(argv[index + 1]);
        index += 1;
      } else {
        values.push("true");
      }
      flags.set(rawName, values);
    } else {
      positionals.push(token);
    }
  }

  return { positionals, flags };
}

function requiredFlag(args: ParsedArgs, name: string): string {
  const value = singleFlag(args, name);
  if (!value || value === "true") {
    throw new AwbsError(`Missing required --${name} value.`);
  }
  return value;
}

function singleFlag(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

function multiFlag(args: ParsedArgs, name: string): string[] {
  const values = args.flags.get(name) ?? [];
  return values.filter((value) => value !== "true");
}

function requiredControllerToken(args: ParsedArgs): string {
  if (!args.flags.has("control-token-stdin")) {
    throw new AwbsError("This trusted write command requires --control-token-stdin.");
  }
  return readSecretFromStdin("controllerToken", "Expected a controller token on stdin.");
}

function readControlInput(): { recoverySecret: string; controllerToken: string } {
  const value = readStdinText();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AwbsError("--control-stdin must provide JSON with recoverySecret and controllerToken.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new AwbsError("--control-stdin must provide JSON with recoverySecret and controllerToken.");
  }
  const input = parsed as Record<string, unknown>;
  if (typeof input.recoverySecret !== "string" || typeof input.controllerToken !== "string") {
    throw new AwbsError("--control-stdin must include string recoverySecret and controllerToken.");
  }
  return {
    recoverySecret: input.recoverySecret,
    controllerToken: input.controllerToken
  };
}

function readControllerTokenFromStdin(): string {
  return readSecretFromStdin("controllerToken", "Expected a controller token on stdin.");
}

function readRecoverySecretFromStdin(): string {
  return readSecretFromStdin("recoverySecret", "Expected a recovery secret on stdin.");
}

function readSecretFromStdin(jsonField: "controllerToken" | "recoverySecret", emptyMessage: string): string {
  const value = readStdinText().trim();
  if (!value) {
    throw new AwbsError(emptyMessage);
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>)[jsonField] === "string") {
      return (parsed as Record<string, string>)[jsonField];
    }
  } catch {
    // Raw secret input is expected for most callers.
  }
  return value;
}

function readStdinText(): string {
  return readFileSync(0, "utf8");
}

function printHelp(): void {
  console.log(`AWBS CLI

Commands:
  awbs init
  awbs index rebuild
  awbs index query [term] [--status active|removed|all] [--json]
  awbs summary set <path> (--text <summary> | --file <file>)
  awbs summary get <path> [--json]
  awbs summary list [--json]
  awbs view create --out <workspace> [--read A] [--write B] --control-token-stdin
  awbs view inspect <viewId> [--json]
  awbs view revoke <viewId> --control-token-stdin
  awbs changeset collect --workspace <workspace>
  awbs changeset inspect <changesetDir|id> [--json]
  awbs changeset apply <changesetDir|id> --control-token-stdin
  awbs ledger bootstrap [--json] --control-token-stdin
  awbs ledger inspect [--json]
  awbs ledger verify [--json]
  awbs db audit [--json]
  awbs db clean-rebuild [--json]
  awbs db backups list [--json]
  awbs authority session start --control-stdin [--json]
  awbs authority session status [--json]
  awbs authority session stop --control-token-stdin [--json]
  awbs authority session recover --recovery-secret-stdin [--json]
  awbs authority verify [--json]
  awbs authority repair-mirrors --control-token-stdin [--json]
`);
}

main().catch((error: unknown) => {
  if (error instanceof AwbsError) {
    console.error(`awbs: ${error.message}`);
  } else if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
