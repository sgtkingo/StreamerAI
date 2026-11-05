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
if ((Test-Path -LiteralPath $programRoot) -or (Get-Service -Name 'StreamerAIServer' -ErrorAction SilentlyContinue)) { throw 'Existing installation detected; upgrades require the supervised update procedure.' }
if (-not $PSCmdlet.ShouldProcess($target, 'Install StreamerAI services')) { return }
New-Item -ItemType Directory -Path $target -Force | Out-Null
Get-ChildItem -LiteralPath $release -Force | Copy-Item -Destination $target -Recurse -ErrorAction Stop
foreach ($subdirectory in @('data','keys','logs','gateway')) { New-Item -ItemType Directory -Path (Join-Path $state $subdirectory) -Force | Out-Null }
& icacls.exe $state /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'State ACL update failed.' }
$masterKey = Join-Path $state 'keys/master.key'
if (-not (Test-Path -LiteralPath $masterKey)) {
  & (Join-Path $target 'runtime/node.exe') -e 'require("node:fs").writeFileSync(process.argv[1],require("node:crypto").randomBytes(32).toString("base64")+"\n",{flag:"wx"})' $masterKey
  if ($LASTEXITCODE -ne 0) { throw 'Master key initialization failed.' }
}
function Escape-Xml([string]$Value) { return [System.Security.SecurityElement]::Escape($Value) }
foreach ($service in @('Server','Gateway')) {
  $serviceDirectory = Join-Path $programRoot "services/$service"
  New-Item -ItemType Directory -Path $serviceDirectory -Force | Out-Null
  $wrapper = Join-Path $serviceDirectory "StreamerAI$service.exe"
  Copy-Item -LiteralPath (Join-Path $target 'bin/streamerai-service.exe') -Destination $wrapper
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
  <serviceaccount><username>NT AUTHORITY\LocalService</username></serviceaccount>
  <startmode>Automatic</startmode><stoptimeout>60sec</stoptimeout>
  <logpath>$(Escape-Xml (Join-Path $state 'logs'))</logpath><log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>3</keepFiles></log>
</service>
"@
  [System.IO.File]::WriteAllText((Join-Path $serviceDirectory "StreamerAI$service.xml"), $xml)
  & $wrapper install
  if ($LASTEXITCODE -ne 0) { throw "Service $service install failed." }
  & $wrapper start
  if ($LASTEXITCODE -ne 0) { throw "Service $service start failed." }
}
Write-Output 'Installed locally: https://localhost:8443. Trust the instance CA before use. User data is retained on service removal.'
