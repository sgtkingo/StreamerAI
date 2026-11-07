[CmdletBinding(SupportsShouldProcess)]
param([switch]$Apply, [switch]$AllowPrototype)
$ErrorActionPreference = 'Stop'
$release = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Apply) {
  Write-Output "Dry run: validate complete bundle; install immutable release in Program Files\StreamerAI; create ProgramData\StreamerAI\{data,keys,logs,gateway}; register LocalService services via bundled WinSW. Pass -Apply in elevated PowerShell to install."
  return
}
if (-not $AllowPrototype) { throw 'Service installer is a prototype; use -AllowPrototype for controlled acceptance testing.' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Installation requires Administrator.' }
& (Join-Path $release 'runtime/node.exe') (Join-Path $release 'service/verify-bundle.mjs') $release --complete
if ($LASTEXITCODE -ne 0) { throw 'Bundle verification failed.' }
$manifest = Get-Content -LiteralPath (Join-Path $release 'bundle.json') -Raw | ConvertFrom-Json
if ($manifest.version -notmatch '^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$') { throw 'Invalid version.' }
$programRoot = Join-Path $env:ProgramFiles 'StreamerAI'
$target = Join-Path $programRoot "releases/$($manifest.version)"
$state = Join-Path $env:ProgramData 'StreamerAI'
$stateExistedBeforeInstall = Test-Path -LiteralPath $state
$trustedStateSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-19')
function New-ManagedSecurity([bool]$Directory, [bool]$PrivateState) {
  $security = if ($Directory) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  foreach ($sid in @('S-1-5-18','S-1-5-32-544','S-1-5-19','S-1-5-32-545')) {
    if ($PrivateState -and $sid -eq 'S-1-5-32-545') { continue }
    $rights = if ($sid -in @('S-1-5-18','S-1-5-32-544')) { [System.Security.AccessControl.FileSystemRights]::FullControl } elseif ($PrivateState) { [System.Security.AccessControl.FileSystemRights]::Modify } else { [System.Security.AccessControl.FileSystemRights]::ReadAndExecute }
    $inheritance = if ($Directory) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
    $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid), $rights, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
  }
  return $security
}
$protectedProgramAcl = New-ManagedSecurity $true $false
$protectedProgramFileAcl = New-ManagedSecurity $false $false
$protectedStateAcl = New-ManagedSecurity $true $true
$protectedStateFileAcl = New-ManagedSecurity $false $true
function Copy-ProtectedTree([string]$Source, [string]$Destination) {
  [System.IO.Directory]::CreateDirectory($Destination, $protectedProgramAcl) | Out-Null
  foreach ($entry in Get-ChildItem -LiteralPath $Source -Force) {
    if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing a reparse point in the server package.' }
    $destinationPath = Join-Path $Destination $entry.Name
    if ($entry.PSIsContainer) { Copy-ProtectedTree $entry.FullName $destinationPath }
    else { Copy-ProtectedFile $entry.FullName $destinationPath }
  }
}
function Copy-ProtectedFile([string]$Source, [string]$Destination) {
  $inputFile = [System.IO.File]::OpenRead($Source)
  try {
    $outputFile = [System.IO.FileStream]::new($Destination, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::Write, [System.IO.FileShare]::None, 65536, [System.IO.FileOptions]::None, $protectedProgramFileAcl)
    try { $inputFile.CopyTo($outputFile) } finally { $outputFile.Dispose() }
  } finally { $inputFile.Dispose() }
}
function Write-ProtectedText([string]$Destination, [string]$Contents, [bool]$PrivateState, [bool]$CreateNew = $true) {
  $fileSecurity = if ($PrivateState) { $protectedStateFileAcl } else { $protectedProgramFileAcl }
  $fileMode = if ($CreateNew) { [System.IO.FileMode]::CreateNew } else { [System.IO.FileMode]::Create }
  $outputFile = [System.IO.FileStream]::new($Destination, $fileMode, [System.Security.AccessControl.FileSystemRights]::Write, [System.IO.FileShare]::None, 65536, [System.IO.FileOptions]::None, $fileSecurity)
  try { $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Contents); $outputFile.Write($bytes, 0, $bytes.Length) } finally { $outputFile.Dispose() }
}
function Initialize-ProtectedMasterKey([string]$MasterKeyPath) {
  if (Test-Path -LiteralPath $MasterKeyPath) { return }
  $keyBytes = [byte[]]::new(32)
  $keyGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $keyGenerator.GetBytes($keyBytes) } finally { $keyGenerator.Dispose() }
  Write-ProtectedText $MasterKeyPath ([Convert]::ToBase64String($keyBytes) + "`n") $true
}
function Assert-ManagedStatePath([string]$StatePath) {
  if (-not (Test-Path -LiteralPath $StatePath)) { return }
  $stateItem = Get-Item -LiteralPath $StatePath -Force -ErrorAction Stop
  if (($stateItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Existing StreamerAI state contains a reparse point; use an explicit reviewed restore instead of adopting it.' }
  $stateAcl = Get-Acl -LiteralPath $StatePath -ErrorAction Stop
  $stateOwner = $stateAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($trustedStateSids -notcontains $stateOwner) { throw 'Existing StreamerAI state is not owned by a managed service or system administrator; use an explicit reviewed restore.' }
  foreach ($stateRule in $stateAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($stateRule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $trustedStateSids -notcontains $stateRule.IdentityReference.Value) { throw 'Existing StreamerAI state grants access outside its managed accounts; use an explicit reviewed restore.' }
  }
}
foreach ($managedPath in @($state, (Join-Path $state 'data'), (Join-Path $state 'keys'), (Join-Path $state 'logs'), (Join-Path $state 'gateway'), (Join-Path $state 'keys/master.key'), (Join-Path $state 'data/secrets.vault'), (Join-Path $state 'data/streamer-ai.db'))) { Assert-ManagedStatePath $managedPath }
if ((Test-Path -LiteralPath $programRoot) -or (Get-Service -Name 'StreamerAIServer' -ErrorAction SilentlyContinue) -or (Get-Service -Name 'StreamerAIGateway' -ErrorAction SilentlyContinue)) { throw 'Existing installation detected; upgrades require the supervised update procedure.' }
if (-not $PSCmdlet.ShouldProcess($target, 'Install StreamerAI services')) { return }
$installationMutex = [System.Threading.Mutex]::new($false, 'Global\StreamerAI-Fresh-Install')
$ownsInstallationMutex = $false
try { $ownsInstallationMutex = $installationMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsInstallationMutex = $true }
if (-not $ownsInstallationMutex) { $installationMutex.Dispose(); throw 'Another StreamerAI installer is running.' }
$attemptedWrappers = [System.Collections.Generic.List[string]]::new()
$programRootCreated = $false
$managedStateReady = $false
try {
if (Test-Path -LiteralPath $programRoot) { throw 'Existing installation detected; upgrades require the supervised update procedure.' }
[System.IO.Directory]::CreateDirectory($programRoot, $protectedProgramAcl) | Out-Null
# New program files use protected ACLs at creation, including their owner. Do not
# rely on the machine's elevated-token default owner or CREATOR OWNER inheritance.
$createdProgramRootAcl = Get-Acl -LiteralPath $programRoot
if ($createdProgramRootAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544' -or -not $createdProgramRootAcl.AreAccessRulesProtected -or ((Get-Item -LiteralPath $programRoot -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'The new program directory is not safely owned and protected.' }
foreach ($programRule in $createdProgramRootAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  $writeRights = [System.Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
  if ($programRule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $programRule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544') -and ($programRule.FileSystemRights -band $writeRights) -ne 0) { throw 'The new program directory grants write access outside administrators.' }
}
$programRootCreated = $true
[System.IO.Directory]::CreateDirectory((Join-Path $programRoot 'releases'), $protectedProgramAcl) | Out-Null
Copy-ProtectedTree $release $target
if ($stateExistedBeforeInstall) { Assert-ManagedStatePath $state } else { [System.IO.Directory]::CreateDirectory($state, $protectedStateAcl) | Out-Null; Assert-ManagedStatePath $state }
Set-Acl -LiteralPath $state -AclObject $protectedStateAcl -ErrorAction Stop
$managedStateReady = $true
foreach ($subdirectory in @('data','keys','logs','gateway')) {
  $managedDirectory = Join-Path $state $subdirectory
  if (Test-Path -LiteralPath $managedDirectory) { Assert-ManagedStatePath $managedDirectory }
  else { [System.IO.Directory]::CreateDirectory($managedDirectory, $protectedStateAcl) | Out-Null }
}
$masterKey = Join-Path $state 'keys/master.key'
Initialize-ProtectedMasterKey $masterKey
function Escape-Xml([string]$Value) { return [System.Security.SecurityElement]::Escape($Value) }
foreach ($service in @('Server','Gateway')) {
  $serviceDirectory = Join-Path $programRoot "services/$service"
  [System.IO.Directory]::CreateDirectory((Join-Path $programRoot 'services'), $protectedProgramAcl) | Out-Null
  [System.IO.Directory]::CreateDirectory($serviceDirectory, $protectedProgramAcl) | Out-Null
  $wrapper = Join-Path $serviceDirectory "StreamerAI$service.exe"
  Copy-ProtectedFile (Join-Path $target 'bin/streamerai-service.exe') $wrapper
  $executable = if ($service -eq 'Server') { Join-Path $target 'runtime/node.exe' } else { Join-Path $target 'bin/caddy.exe' }
  $arguments = if ($service -eq 'Server') { '"' + (Join-Path $target 'service/start.mjs') + '"' } else { 'run --config "' + (Join-Path $target 'service/Caddyfile') + '" --adapter caddyfile' }
  $xml = @"
<service>
  <id>StreamerAI$service</id><name>StreamerAI $service</name>
  <description>StreamerAI local server distribution prototype</description>
  <executable>$(Escape-Xml $executable)</executable><arguments>$(Escape-Xml $arguments)</arguments>
  <workingdirectory>$(Escape-Xml $state)</workingdirectory>
  <env name="STREAMERAI_STATE_ROOT" value="$(Escape-Xml $state)"/>
  <env name="STREAMERAI_RELEASE_ROOT" value="$(Escape-Xml $target)"/>
  <serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
  <startmode>Automatic</startmode><stoptimeout>60sec</stoptimeout>
  <logpath>$(Escape-Xml (Join-Path $state 'logs'))</logpath><log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>3</keepFiles></log>
</service>
"@
  Write-ProtectedText (Join-Path $serviceDirectory "StreamerAI$service.xml") $xml $false
  $attemptedWrappers.Add($wrapper)
  & $wrapper install
  if ($LASTEXITCODE -ne 0) { throw "Service $service install failed." }
  $installedService = Get-CimInstance -ClassName Win32_Service -Filter "Name='StreamerAI$service'" -ErrorAction Stop
  if (-not $installedService) { throw "Service $service account could not be verified before start." }
  $installedServiceSid = [System.Security.Principal.NTAccount]::new($installedService.StartName).Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($installedServiceSid -ne 'S-1-5-19') { throw "Service $service did not register as LocalService; refusing to start it." }
  & $wrapper start
  if ($LASTEXITCODE -ne 0) { throw "Service $service start failed." }
}
Write-Output 'Installed locally: https://localhost:8443. Trust the instance CA before use. User data is retained on service removal.'
} catch {
  $installationFailure = $_
  $cleanupFailures = [System.Collections.Generic.List[string]]::new()
  $rollbackWrappers = @($attemptedWrappers.ToArray())
  [Array]::Reverse($rollbackWrappers)
  foreach ($attemptedWrapper in $rollbackWrappers) {
    $serviceName = [System.IO.Path]::GetFileNameWithoutExtension($attemptedWrapper)
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
      try {
      & $attemptedWrapper stop 2>$null | Out-Null
      & $attemptedWrapper uninstall 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0 -or (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) { $cleanupFailures.Add("Could not remove the newly registered $serviceName service.") }
      } catch { $cleanupFailures.Add("Could not completely roll back the newly registered $serviceName service.") }
    }
  }
  if ($programRootCreated -and $cleanupFailures.Count -eq 0) {
    try {
      $resolvedCleanup = [System.IO.Path]::GetFullPath($programRoot)
      $expectedCleanup = [System.IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'StreamerAI'))
      $programFilesPrefix = [System.IO.Path]::GetFullPath($env:ProgramFiles).TrimEnd('\') + '\'
      if (-not $resolvedCleanup.Equals($expectedCleanup, [System.StringComparison]::OrdinalIgnoreCase) -or -not $resolvedCleanup.StartsWith($programFilesPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside the new StreamerAI program directory.' }
      $cleanupItem = Get-Item -LiteralPath $resolvedCleanup -ErrorAction Stop
      if (($cleanupItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing recursive cleanup of a reparse point.' }
      Remove-Item -LiteralPath $resolvedCleanup -Recurse -Force -ErrorAction Stop
    } catch { $cleanupFailures.Add('The new program files could not be completely removed.') }
  }
  # State, keys, models and user data are always retained, including on first-install failure.
  $failureJournal = $null
  if ($managedStateReady) { $failureJournal = Join-Path $state 'installation-failure.json' }
  elseif ($programRootCreated -and (Test-Path -LiteralPath $programRoot) -and ((Get-Item -LiteralPath $programRoot -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { $failureJournal = Join-Path $programRoot 'installation-failure.json' }
  if ($failureJournal) { Write-ProtectedText $failureJournal (@{ version = $manifest.version; createdAt = [DateTime]::UtcNow.ToString('o'); programRoot = $programRoot; requiresRepair = ($cleanupFailures.Count -ne 0); reason = $installationFailure.Exception.Message; cleanup = $cleanupFailures.ToArray() } | ConvertTo-Json -Depth 4) $managedStateReady $false }
  $journalHint = if ($failureJournal) { " See $failureJournal." } else { '' }
  if ($cleanupFailures.Count -ne 0) { throw "Installation stopped and needs local repair.$journalHint Your server data and keys were retained." }
  throw "Installation stopped; newly installed services and program files were rolled back. Your server data and keys were retained. You can retry.$journalHint Reason: $($installationFailure.Exception.Message)"
} finally {
  if ($ownsInstallationMutex) { $installationMutex.ReleaseMutex() }
  $installationMutex.Dispose()
}
