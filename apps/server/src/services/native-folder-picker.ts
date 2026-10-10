import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Opens a folder dialog on the machine running the home server. */
export async function pickServerFolder(): Promise<string | null> {
  let command: string;
  let args: string[];
  if (process.platform === "win32") {
    command = "powershell.exe";
    args = [
      "-NoLogo",
      "-NoProfile",
      "-STA",
      "-Command",
      [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$dialog.Description = 'Select a folder for StreamerAI'",
        "$dialog.ShowNewFolderButton = $true",
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
      ].join("; "),
    ];
  } else if (process.platform === "darwin") {
    command = "osascript";
    args = [
      "-e",
      'POSIX path of (choose folder with prompt "Select a folder for StreamerAI")',
    ];
  } else {
    command = "zenity";
    args = [
      "--file-selection",
      "--directory",
      "--title=Select a folder for StreamerAI",
    ];
  }
  try {
    const { stdout } = await run(command, args, {
      timeout: 120_000,
      maxBuffer: 4096,
      windowsHide: true,
    });
    return stdout.trim() || null;
  } catch (error) {
    if (String((error as NodeJS.ErrnoException).code) === "1") return null;
    throw new Error(
      "The folder picker is unavailable on this server. Enter the folder path instead.",
      { cause: error },
    );
  }
}
