<#
.SYNOPSIS
  Prepares and publishes a StreamerAI release.

.DESCRIPTION
  1. One-time setup (skipped when already done):
     - Ed25519 update signing key  -> $KeyDirectory\update-signing.pem, public key pinned in packaging/update-trust.json
     - Android release keystore    -> $KeyDirectory\streamerai-release.jks (+ passwords in android-keystore.txt)
     - GitHub environment "release" and its secrets
  2. Runs the quality gate and pushes a release commit to main whose message
     carries (patch), (minor) or (major). The release workflow then bumps the
     version, stamps RELEASE_NOTES.md, tags vX.Y.Z and publishes the release.

  Keep $KeyDirectory backed up offline. Losing it means installed servers and
  Android apps can no longer accept updates.

.EXAMPLE
  ./scripts/Release.ps1 -Bump minor
  ./scripts/Release.ps1 -Bump patch -Message "Fix playback on TV" -SkipChecks -Yes
  ./scripts/Release.ps1 -SetupOnly
#>
[CmdletBinding()]
param(
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Bump,
  [string]$Message,
  [string]$KeyDirectory = (Join-Path $HOME '.streamerai-release'),
  [switch]$SetupOnly,
  [switch]$SkipChecks,
  [switch]$Yes
)
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repository

function Step([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }
function Confirm([string]$Question) {
  if ($Yes) { return $true }
  return (Read-Host "$Question [y/N]") -match '^(y|yes|a|ano)$'
}
function Invoke-Checked([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') failed (exit $LASTEXITCODE)." }
}
function Require([string]$Command, [string]$Hint) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { throw "$Command was not found. $Hint" }
}
function New-Secret([int]$Bytes = 24) {
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  return ([Convert]::ToBase64String($buffer) -replace '[+/=]', '').Substring(0, 28)
}
function Set-GitHubSecret([string]$Name, [string]$Value) {
  # The value goes through stdin, never through the command line.
  $Value | gh secret set $Name --env release --repo $script:Repo
  if ($LASTEXITCODE -ne 0) { throw "Could not store GitHub secret $Name." }
  Write-Host "  secret $Name stored"
}
function Find-Keytool {
  $command = Get-Command keytool -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $candidates = @()
  if ($env:JAVA_HOME) { $candidates += Join-Path $env:JAVA_HOME 'bin\keytool.exe' }
  $candidates += @(
    "$env:ProgramFiles\Android\Android Studio\jbr\bin\keytool.exe",
    "$env:ProgramFiles\Android\Android Studio\jre\bin\keytool.exe"
  )
  foreach ($root in @("$env:ProgramFiles\Eclipse Adoptium", "$env:ProgramFiles\Java", "$env:ProgramFiles\Microsoft")) {
    if (Test-Path $root) { $candidates += Get-ChildItem $root -Recurse -Filter keytool.exe -ErrorAction SilentlyContinue | ForEach-Object FullName }
  }
  return $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

Step 'Checking tools'
Require git 'Install Git for Windows.'
Require node 'Install Node.js 24 LTS.'
Require pnpm 'Run: npm install --global pnpm@10.17.1'
Require gh 'Install GitHub CLI (winget install GitHub.cli) and run: gh auth login'
gh auth status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI is not signed in. Run: gh auth login' }
$script:Repo = (gh repo view --json nameWithOwner --jq .nameWithOwner)
if (-not $script:Repo) { throw 'Could not determine the GitHub repository.' }
Write-Host "  repository: $script:Repo"

if (-not $SetupOnly) {
  if (-not $Bump) { $Bump = Read-Host 'Release level (patch / minor / major)' }
  if ($Bump -notin 'patch', 'minor', 'major') { throw "Invalid release level '$Bump'." }
  $branch = git rev-parse --abbrev-ref HEAD
  if ($branch -ne 'main') { throw "Releases are made from main (current branch: $branch). Merge your work into main first." }
  git fetch origin main --quiet
  if (git rev-list --count HEAD..origin/main) { throw 'main is behind origin/main. Pull first.' }
}

# ---------------------------------------------------------------- one-time setup
New-Item -ItemType Directory -Force $KeyDirectory | Out-Null
Step "One-time setup (keys in $KeyDirectory)"
# Environment "release": secrets are only available to workflow runs on main.
'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
  gh api -X PUT "repos/$script:Repo/environments/release" --input - --silent
if ($LASTEXITCODE -ne 0) { throw 'Could not create the GitHub environment "release".' }
$policies = @(gh api "repos/$script:Repo/environments/release/deployment-branch-policies" --jq '.branch_policies[].name')
if ($policies -notcontains 'main') {
  gh api -X POST "repos/$script:Repo/environments/release/deployment-branch-policies" -f name=main -f type=branch --silent
  if ($LASTEXITCODE -ne 0) { throw 'Could not limit the "release" environment to main.' }
}
Write-Host '  environment "release" (main only)'

$existingSecrets = @(gh secret list --env release --repo $script:Repo --json name --jq '.[].name')

# Update signing key (Ed25519)
$updateKey = Join-Path $KeyDirectory 'update-signing.pem'
$trust = Get-Content packaging/update-trust.json -Raw | ConvertFrom-Json
$trustHasKey = @($trust.keys.PSObject.Properties).Count -gt 0
$trustChanged = $false
if (-not $trustHasKey) {
  if (Test-Path $updateKey) { throw "$updateKey exists but packaging/update-trust.json has no key. Restore the trust file from git history or move the old key away." }
  Write-Host '  generating the update signing key'
  Invoke-Checked node @('scripts/distribution/generate-update-key.mjs', '--private-key', $updateKey)
  $trustChanged = $true
} elseif (-not (Test-Path $updateKey) -and $existingSecrets -notcontains 'STREAMERAI_UPDATE_SIGNING_KEY') {
  throw "packaging/update-trust.json pins a key, but neither $updateKey nor the GitHub secret exists. Restore the key from your backup."
} else { Write-Host '  update signing key: already set up' }
if ((Test-Path $updateKey) -and ($trustChanged -or $existingSecrets -notcontains 'STREAMERAI_UPDATE_SIGNING_KEY')) {
  Set-GitHubSecret 'STREAMERAI_UPDATE_SIGNING_KEY' (Get-Content $updateKey -Raw)
}

# Android release keystore
$keystore = Join-Path $KeyDirectory 'streamerai-release.jks'
$keystoreInfo = Join-Path $KeyDirectory 'android-keystore.txt'
$androidSecrets = 'STREAMERAI_ANDROID_KEYSTORE_BASE64', 'STREAMERAI_ANDROID_KEYSTORE_PASSWORD', 'STREAMERAI_ANDROID_KEY_ALIAS', 'STREAMERAI_ANDROID_KEY_PASSWORD'
$androidMissing = @($androidSecrets | Where-Object { $existingSecrets -notcontains $_ }).Count -gt 0
if (-not (Test-Path $keystore) -and $androidMissing) {
  $keytool = Find-Keytool
  if (-not $keytool) { throw 'keytool was not found. Install a JDK 17 (winget install EclipseAdoptium.Temurin.17.JDK) or Android Studio, then run this script again.' }
  $password = New-Secret
  Write-Host '  generating the Android release keystore'
  # PKCS12 keystores use one password for the store and the key.
  Invoke-Checked $keytool @('-genkeypair', '-keystore', $keystore, '-storetype', 'PKCS12', '-alias', 'streamerai',
    '-keyalg', 'RSA', '-keysize', '4096', '-validity', '10000', '-storepass', $password, '-keypass', $password,
    '-dname', 'CN=StreamerAI, O=StreamerAI', '-noprompt')
  Set-Content -Path $keystoreInfo -Encoding UTF8 -Value "alias=streamerai`nstorePassword=$password`nkeyPassword=$password"
}
if ($androidMissing) {
  if (-not (Test-Path $keystore) -or -not (Test-Path $keystoreInfo)) { throw "Android secrets are missing and $keystore / $keystoreInfo are not available. Restore them from your backup." }
  $info = @{}; Get-Content $keystoreInfo | ForEach-Object { $name, $value = $_ -split '=', 2; $info[$name] = $value }
  Set-GitHubSecret 'STREAMERAI_ANDROID_KEYSTORE_BASE64' ([Convert]::ToBase64String([IO.File]::ReadAllBytes($keystore)))
  Set-GitHubSecret 'STREAMERAI_ANDROID_KEYSTORE_PASSWORD' $info.storePassword
  Set-GitHubSecret 'STREAMERAI_ANDROID_KEY_ALIAS' $info.alias
  Set-GitHubSecret 'STREAMERAI_ANDROID_KEY_PASSWORD' $info.keyPassword
} else { Write-Host '  Android keystore: already set up' }

if ($trustChanged) {
  Write-Host "`n  BACK UP $KeyDirectory OFFLINE NOW (USB drive or password manager)." -ForegroundColor Yellow
  Write-Host '  Without these files no future update can be signed.' -ForegroundColor Yellow
}

if ($SetupOnly) {
  if ($trustChanged) {
    git add packaging/update-trust.json
    git commit -m 'Pin the release update signing key' | Out-Null
    Write-Host '  committed packaging/update-trust.json (push it with your next release)'
  }
  Write-Host "`nSetup complete." -ForegroundColor Green
  return
}

# ---------------------------------------------------------------- release
Step "Release ($Bump)"
$current = node scripts/distribution/set-version.mjs --check
$next = node --input-type=module -e "import {nextVersion} from './scripts/distribution/release-notes.mjs'; console.log(nextVersion('$current', '$Bump'))"
$notes = node scripts/distribution/release-notes.mjs
Write-Host "  $current -> $next"
if (-not ($notes -join '').Trim()) {
  Write-Host '  RELEASE_NOTES.md has nothing under "## Unreleased"; the release will say "Maintenance release."' -ForegroundColor Yellow
  if (-not (Confirm 'Continue without release notes?')) { return }
} else { Write-Host "  Release notes:"; $notes | ForEach-Object { Write-Host "    $_" } }

if (-not $SkipChecks) {
  Step 'Quality gate (pnpm check, distribution tests)'
  Invoke-Checked pnpm @('check')
  Invoke-Checked pnpm @('distribution:test')
}

Step 'Release commit'
git add -A
git status --short
$summary = if ($Message) { $Message } else { "Release $next" }
if (-not (Confirm "Push '$summary ($Bump)' to main and publish StreamerAI $next?")) {
  Write-Host 'Stopped before committing; changes stay staged.' -ForegroundColor Yellow
  return
}
# The marker in the message starts the release workflow; an empty commit is fine.
Invoke-Checked git @('commit', '--allow-empty', '-m', "$summary ($Bump)")
Invoke-Checked git @('push', 'origin', 'main')

Step 'Release workflow'
Start-Sleep -Seconds 8
$run = gh run list --repo $script:Repo --workflow release.yml --branch main --limit 1 --json databaseId,url --jq '.[0]' | ConvertFrom-Json
if ($run) {
  Write-Host "  $($run.url)"
  if (Confirm 'Follow the workflow here until it finishes?') { gh run watch $run.databaseId --repo $script:Repo --exit-status }
}
Write-Host "`nAfter the workflow finishes: https://github.com/$script:Repo/releases/tag/v$next" -ForegroundColor Green
Write-Host 'Run git pull: the workflow pushes the version bump commit to main.'
