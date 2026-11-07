import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildWindowsSetup } from "./setup-windows.mjs";

const isWindows = process.platform === "win32";
function fixture() {
  const temporary = mkdtempSync(
    path.join(os.tmpdir(), "streamerai-setup-test-"),
  );
  const bundle = path.join(temporary, "server bundle");
  mkdirSync(bundle);
  writeFileSync(
    path.join(bundle, "bundle.json"),
    JSON.stringify({
      format: "streamerai-runtime-bundle/v1",
      version: "0.1.0",
      platform: "win-x64",
      complete: false,
      releaseReady: false,
      files: [],
    }),
  );
  return {
    temporary,
    bundle,
    cleanup() {
      assert.ok(
        path
          .resolve(temporary)
          .startsWith(path.resolve(os.tmpdir()) + path.sep),
      );
      rmSync(temporary, { recursive: true, force: true });
    },
  };
}

test(
  "Windows setup refuses incomplete installation and unpinned third-party sources",
  { skip: !isWindows },
  () => {
    const item = fixture();
    try {
      assert.throws(
        () =>
          buildWindowsSetup({
            bundle: item.bundle,
            output: path.join(item.temporary, "not-created"),
          }),
        /complete component bundle/,
      );
      assert.equal(existsSync(path.join(item.temporary, "not-created")), false);
      assert.throws(
        () =>
          buildWindowsSetup({
            bundle: item.bundle,
            output: path.join(item.temporary, "not-created"),
            review: true,
            ollama: {
              url: "https://example.com/OllamaSetup.exe",
              sha256: "a".repeat(64),
              bytes: 100,
            },
          }),
        /Invalid pinned official/,
      );
      assert.equal(existsSync(path.join(item.temporary, "not-created")), false);
    } finally {
      item.cleanup();
    }
  },
);

test(
  "compiled review wizard verifies its resource, renders without install, and rejects payload tampering",
  { skip: !isWindows },
  () => {
    const item = fixture();
    try {
      const output = path.join(item.temporary, "setup output");
      const result = buildWindowsSetup({
        bundle: item.bundle,
        output,
        review: true,
      });
      assert.equal(result.reviewOnly, true);
      const report = JSON.parse(result.selfTest);
      assert.equal(report.payloadVerified, true);
      assert.equal(report.gatewayRepairVerified, true);
      assert.equal(report.exactModelMatchVerified, true);
      assert.equal(report.protectedCreationVerified, true);
      assert.equal(report.ownerHandoffVerified, true);
      assert.equal(report.preview, true);
      const icon = readFileSync(path.join(output, "StreamerAI.ico"));
      assert.deepEqual(icon.subarray(0, 4), Buffer.from([0, 0, 1, 0]));
      assert.equal(icon.readUInt16LE(4), 6);
      const executable = readFileSync(result.executable);
      assert.equal(executable.subarray(0, 2).toString("ascii"), "MZ");
      const image = path.join(item.temporary, "wizard.png");
      const rendered = spawnSync(
        result.executable,
        ["--preview-image", image],
        { windowsHide: true, encoding: "utf8", timeout: 10000 },
      );
      assert.equal(rendered.status, 0, rendered.stderr);
      assert.deepEqual(
        readFileSync(image).subarray(0, 8),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      const resultImages = [];
      for (const state of ["success", "error", "options"]) {
        const resultImage = path.join(item.temporary, `${state}.png`);
        const renderedResult = spawnSync(
          result.executable,
          ["--preview-image", resultImage, "--preview-state", state],
          { windowsHide: true, encoding: "utf8", timeout: 10000 },
        );
        assert.equal(renderedResult.status, 0, renderedResult.stderr);
        resultImages.push(readFileSync(resultImage));
      }
      assert.notDeepEqual(resultImages[0], resultImages[1]);
      assert.notDeepEqual(resultImages[0], readFileSync(image));
      assert.notDeepEqual(resultImages[2], readFileSync(image));
      const pixels = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Add-Type -AssemblyName System.Drawing;$previewBitmap=[System.Drawing.Bitmap]::FromFile($env:STREAMERAI_TEST_PREVIEW);$interfacePixels=0;try{for($pixelY=60;$pixelY -lt $previewBitmap.Height-25;$pixelY+=2){for($pixelX=20;$pixelX -lt $previewBitmap.Width-20;$pixelX+=2){$pixel=$previewBitmap.GetPixel($pixelX,$pixelY);if([Math]::Abs([int]$pixel.R-20)+[Math]::Abs([int]$pixel.G-21)+[Math]::Abs([int]$pixel.B-29) -gt 60){$interfacePixels++}}};Write-Output $interfacePixels}finally{$previewBitmap.Dispose()}",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, STREAMERAI_TEST_PREVIEW: image },
          timeout: 15000,
        },
      );
      assert.equal(pixels.status, 0, pixels.stderr);
      assert.ok(
        Number(pixels.stdout.trim()) > 1000,
        "the saved image contains visible controls/text, not only the empty Form background",
      );
      const payload = readFileSync(path.join(output, "server.zip"));
      const offset = executable.indexOf(payload);
      assert.ok(
        offset > 0,
        "the actual server ZIP is embedded in the executable",
      );
      const modified = Buffer.from(executable);
      modified[offset + 20] ^= 1;
      const tampered = path.join(item.temporary, "tampered-review.exe");
      writeFileSync(tampered, modified);
      const checked = spawnSync(tampered, ["--self-test"], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 10000,
      });

      assert.equal(checked.status, 1);
      assert.match(checked.stderr, /embedded server package is damaged/);
      assert.notEqual(
        createHash("sha256").update(executable).digest("hex"),
        createHash("sha256").update(modified).digest("hex"),
      );
    } finally {
      item.cleanup();
    }
  },
);

test(
  "read-only managed-state check rejects untrusted receipt storage and reparse ancestors",
  { skip: !isWindows },
  () => {
    const item = fixture();
    try {
      const result = buildWindowsSetup({
        bundle: item.bundle,
        output: path.join(item.temporary, "guard setup"),
        review: true,
      });
      const state = path.join(item.temporary, "untrusted-state");
      mkdirSync(state);
      writeFileSync(
        path.join(state, "setup-receipt.json"),
        "THIS IS NOT JSON AND MUST NOT BE PARSED",
      );
      const permissions = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$testAcl=Get-Acl -LiteralPath $env:STREAMERAI_TEST_STATE;$testAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),[System.Security.AccessControl.FileSystemRights]::ReadAndExecute,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow));Set-Acl -LiteralPath $env:STREAMERAI_TEST_STATE -AclObject $testAcl",
        ],
        {
          windowsHide: true,
          encoding: "utf8",
          env: { ...process.env, STREAMERAI_TEST_STATE: state },
          timeout: 10000,
        },
      );
      assert.equal(permissions.status, 0, permissions.stderr);
      const checked = spawnSync(
        result.executable,
        ["--check-managed-state", state],
        { encoding: "utf8", windowsHide: true, timeout: 10000 },
      );
      assert.equal(checked.status, 1);
      assert.match(
        checked.stderr,
        /Managed server paths (?:are not owned|grant access)/,
      );
      assert.equal(
        readFileSync(path.join(state, "setup-receipt.json"), "utf8"),
        "THIS IS NOT JSON AND MUST NOT BE PARSED",
      );
      const junction = path.join(item.temporary, "state-junction");
      symlinkSync(state, junction, "junction");
      const redirected = spawnSync(
        result.executable,
        ["--check-managed-state", junction],
        { encoding: "utf8", windowsHide: true, timeout: 10000 },
      );
      assert.equal(redirected.status, 1);
      assert.match(redirected.stderr, /must not contain reparse points/);
    } finally {
      item.cleanup();
    }
  },
);

test(
  "PowerShell protected-file helper generates a 32-byte key and preserves existing keys",
  { skip: !isWindows },
  () => {
    const item = fixture();
    try {
      // Load only these side-effect-free helper definitions, never the installer
      // body. Use a fixture ACL owned by this test user, so no elevation is needed.
      const command =
        "$ErrorActionPreference='Stop';$tokens=$null;$errors=$null;$tree=[System.Management.Automation.Language.Parser]::ParseFile($env:STREAMERAI_SCRIPT_TO_CHECK,[ref]$tokens,[ref]$errors);$names=@('New-ManagedSecurity','Write-ProtectedText','Initialize-ProtectedMasterKey');$helpers=$tree.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $names},$true);if($helpers.Count -ne 3){throw 'Missing helper'};foreach($helper in $helpers){Invoke-Expression $helper.Extent.Text};$private=New-ManagedSecurity $false $true;if(-not $private.AreAccessRulesProtected -or $private.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544'){throw 'Private security descriptor is not protected and administrator-owned'};foreach($rule in $private.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544','S-1-5-19')){throw 'Unexpected private ACE'}};$testOwner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$protectedStateFileAcl=[System.Security.AccessControl.FileSecurity]::new();$protectedStateFileAcl.SetAccessRuleProtection($true,$false);$protectedStateFileAcl.SetOwner($testOwner);$protectedStateFileAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($testOwner,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow));$testKey=Join-Path $env:STREAMERAI_TEST_DIRECTORY 'master.key';Initialize-ProtectedMasterKey $testKey;$first=[System.IO.File]::ReadAllText($testKey);if([Convert]::FromBase64String($first.Trim()).Length -ne 32){throw 'Key is not 32 bytes'};Initialize-ProtectedMasterKey $testKey;if([System.IO.File]::ReadAllText($testKey) -cne $first){throw 'Existing key changed'};$refused=$false;try{Write-ProtectedText $testKey 'replacement' $true}catch [System.IO.IOException]{$refused=$true};if(-not $refused){throw 'CreateNew overwrote a key'};if([System.IO.File]::ReadAllText($testKey) -cne $first){throw 'Existing key changed after refusal'};Write-Output 'protected-key-fixture-passed'";
      const checked = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        {
          encoding: "utf8",
          windowsHide: true,
          env: {
            ...process.env,
            STREAMERAI_SCRIPT_TO_CHECK: path.resolve(
              "packaging/templates/install-windows.ps1",
            ),
            STREAMERAI_TEST_DIRECTORY: item.temporary,
          },
          timeout: 10000,
        },
      );
      assert.equal(checked.status, 0, checked.stderr);
      assert.match(checked.stdout, /protected-key-fixture-passed/);
    } finally {
      item.cleanup();
    }
  },
);

test(
  "Windows service script dry-run and generated WinSW 2 account configuration are safe",
  { skip: !isWindows },
  () => {
    const filename = path.resolve("packaging/templates/install-windows.ps1");
    // Evaluate only the XML assignment against fixture paths, not the installer
    // body. WinSW 2.12 combines domain + user; its parser ignores username.
    const command = [
      "$ErrorActionPreference='Stop';$tokens=$null;$errors=$null",
      "$tree=[System.Management.Automation.Language.Parser]::ParseFile($env:STREAMERAI_SCRIPT_TO_CHECK,[ref]$tokens,[ref]$errors)",
      "if($errors.Count){$errors|Out-String|Write-Error;exit 1}",
      "& $env:STREAMERAI_SCRIPT_TO_CHECK",
      "$xmlAssignment=$tree.Find({param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and $node.Left.VariablePath.UserPath -eq 'xml'},$true)",
      "if(-not $xmlAssignment){throw 'Missing generated service XML'}",
      "$service='Server';$executable='C:/fixture/node.exe';$arguments='C:/fixture/start.mjs';$state='C:/fixture/state';$target='C:/fixture/release'",
      "function Escape-Xml([string]$Value){[System.Security.SecurityElement]::Escape($Value)}",
      "Invoke-Expression $xmlAssignment.Extent.Text",
      "$configuration=[xml]$xml;$account=$configuration.service.serviceaccount",
      "if($account.username -or $account.domain -cne 'NT AUTHORITY' -or $account.user -cne 'LocalService'){throw 'WinSW 2 account would not resolve to LocalService'}",
      "Write-Output 'winsw-2-localservice-contract-passed'",
    ].join(";");
    const checked = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, STREAMERAI_SCRIPT_TO_CHECK: filename },
        timeout: 10000,
      },
    );
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /Dry run/);
    assert.match(checked.stdout, /winsw-2-localservice-contract-passed/);
  },
);
