import { emitKeypressEvents, type Key } from "node:readline";
import { basename, join } from "node:path";
import { loadLocalEnvironment, readRuntimeConfig } from "../runtime-config.js";
import {
  createServerBackup,
  previewServerBackup,
  inspectServerBackup,
  restoreServerBackup,
  recoverInterruptedServerRestore,
  type BackupExtraFile,
} from "./server-backup.js";

const usage = `Offline encrypted StreamerAI server backup (Node >=24.7).
Stop the StreamerAI service first. No command contacts the network.

export  [--data-dir DIR] [--vault-file FILE] --key-file FILE --output FILE
        [--account-id ID]
        [--config-file FILE] [--media-file FILE] [--model-file FILE] [--installer-file FILE]
inspect --input FILE
restore --input FILE --target STATE_ROOT --mode replace|new-server
        [--overwrite] [--source-retired]
recover --target STATE_ROOT

Export uses the selected account's verified Master PIN from the encrypted vault.
With multiple households, --account-id is required. Verify the PIN in the app first.
For inspect/restore, enter the Master PIN used when the backup was created.
Legacy backup passphrases are also accepted for inspect/restore.
Passphrase is read with terminal echo disabled, or as one line from stdin.
Never put a passphrase in command arguments or environment variables.
Export always creates a new filename. Restore uses STATE_ROOT/data and STATE_ROOT/keys.
replace requires --source-retired; overwriting a populated state root requires --overwrite.
External configuration files are restored under extras/ for review, never activated automatically.
`;

async function passphrase(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding("utf8");
    let value = "";
    for await (const chunk of process.stdin) {
      value += String(chunk);
      if (Buffer.byteLength(value) > 1028)
        throw new Error("Passphrase input is too long.");
      if (value.includes("\n")) break;
    }
    return value.replace(/\r?\n$/, "");
  }
  process.stderr.write(label);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return await new Promise<string>((done, fail) => {
    const characters: string[] = [];
    function finish(error?: Error) {
      process.stdin.off("keypress", keypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
      if (error) fail(error);
      else done(characters.join(""));
      characters.fill("");
    }
    function keypress(character: string | undefined, key: Key) {
      if (key.ctrl && key.name === "c") {
        finish(new Error("Backup cancelled."));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish();
        return;
      }
      if (key.name === "backspace") {
        characters.pop();
        return;
      }
      if (
        character &&
        !key.ctrl &&
        !key.meta &&
        ![...character].some(
          (item) => item.charCodeAt(0) < 32 || item.charCodeAt(0) === 127,
        )
      ) {
        characters.push(character);
        if (Buffer.byteLength(characters.join("")) > 1024)
          finish(new Error("Passphrase input is too long."));
      }
    }
    process.stdin.on("keypress", keypress);
  });
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(usage);
    return;
  }
  if (!["export", "inspect", "restore", "recover"].includes(command))
    throw new Error("Unknown backup command. Use --help.");
  const flags = new Set<string>(),
    values = new Map<string, string>(),
    extras: BackupExtraFile[] = [];
  const valued = new Set([
    "--data-dir",
    "--vault-file",
    "--key-file",
    "--output",
    "--input",
    "--target",
    "--mode",
    "--account-id",
  ]);
  const kinds = new Map<string, BackupExtraFile["kind"]>([
    ["--config-file", "configuration"],
    ["--media-file", "media"],
    ["--model-file", "model"],
    ["--installer-file", "installer"],
  ]);
  for (let index = 0; index < arguments_.length; index++) {
    const name = arguments_[index]!;
    if (["--overwrite", "--source-retired"].includes(name)) {
      flags.add(name);
      continue;
    }
    const kind = kinds.get(name);
    if (!valued.has(name) && !kind)
      throw new Error(
        "Unknown backup argument. Use --help; passphrases are accepted only through stdin.",
      );
    const value = arguments_[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${name}.`);
    if (kind)
      extras.push({
        source: value,
        path: `extras/${kind}/${basename(value)}`,
        kind,
      });
    else {
      if (values.has(name)) throw new Error(`Duplicate argument ${name}.`);
      values.set(name, value);
    }
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing required argument ${name}.`);
    return value;
  };
  if (command === "recover") {
    process.stdout.write(
      `${JSON.stringify(await recoverInterruptedServerRestore(required("--target")), null, 2)}\n`,
    );
    return;
  }
  loadLocalEnvironment();
  const runtime = readRuntimeConfig();
  if (command === "export") {
    const keyFile = values.get("--key-file") ?? runtime.secrets.keyFile;
    if (!keyFile)
      throw new Error(
        "Persistent encrypted backup requires --key-file or STREAMERAI_SECRET_KEY_FILE.",
      );
    const dataDirectory = values.get("--data-dir") ?? runtime.server.dataDir;
    const outputFile = required("--output");
    const vaultFile =
      values.get("--vault-file") ??
      (values.has("--data-dir")
        ? join(dataDirectory, "secrets.vault")
        : runtime.secrets.vaultFile);
    const preview = await previewServerBackup({
      dataDirectory,
      vaultFile,
      keyFile,
      outputFile,
      appVersion: "0.1.0",
      extraFiles: extras,
    });
    process.stderr.write(`${JSON.stringify(preview, null, 2)}\n`);
    process.stderr.write(
      "Includes complete database, provider vault and its key. Media/models/configuration require explicit selection. Maximum 256 MiB.\n",
    );
    const households = preview.database.accounts.filter(
      (account) => account.profiles > 0,
    );
    const accountId =
      values.get("--account-id") ??
      (households.length === 1 ? households[0]!.id : undefined);
    if (
      !accountId ||
      !preview.database.accounts.some((account) => account.id === accountId)
    )
      throw new Error("Select a backup account with --account-id.");
    const result = await createServerBackup({
      dataDirectory,
      vaultFile,
      keyFile,
      outputFile,
      accountId,
      appVersion: "0.1.0",
      extraFiles: extras,
    });
    process.stdout.write(
      `${JSON.stringify({ file: outputFile, ...result }, null, 2)}\n`,
    );
  } else {
    const file = required("--input");
    const targetDirectory =
      command === "restore" ? required("--target") : undefined;
    const mode = command === "restore" ? required("--mode") : undefined;
    if (mode && mode !== "replace" && mode !== "new-server")
      throw new Error("Restore mode must be replace or new-server.");
    const password = await passphrase(
      "Backup Master PIN (or legacy passphrase): ",
    );
    const manifest = await inspectServerBackup({ file, passphrase: password });
    process.stderr.write(`${JSON.stringify(manifest, null, 2)}\n`);
    if (command === "restore") {
      const result = await restoreServerBackup({
        file,
        passphrase: password,
        targetDirectory: targetDirectory!,
        mode: mode as "replace" | "new-server",
        overwriteConfirmed: flags.has("--overwrite"),
        sourceRetiredConfirmed: flags.has("--source-retired"),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  }
}

main().catch(() => {
  // Do not echo arbitrary parser, filesystem or crypto exception text: it may
  // contain user-controlled input or names from encrypted backup contents.
  process.stderr.write(
    "Offline backup operation failed. Check the command, passphrase, free space, stopped-service state and compatible schema. Use --help for options.\n",
  );
  process.exitCode = 1;
});
