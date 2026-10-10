# Runs the StarkFlow server on this PC and makes it public without Docker.
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools/run-public.ps1
#         powershell -ExecutionPolicy Bypass -File tools/run-public.ps1 -Port 8080 -NoBuild
#         powershell -ExecutionPolicy Bypass -File tools/run-public.ps1 -TunnelToken eyJhIjoi...
#
# A quick tunnel (no token) prints a random https://xxxx.trycloudflare.com address that
# changes on every restart. With -TunnelToken the public hostname is the stable one from
# Cloudflare Zero Trust -> Networks -> Tunnels. Plugin Server URL: wss://<host>/ws.
param(
	[int]$Port = 8080,
	[string]$Secret = '',
	[string]$TunnelToken = '',
	[switch]$NoBuild
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'dist\starkflow.exe'
$envFile = Join-Path $root '.env'
$logDir = Join-Path $root 'dist\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Get-EnvValue([string]$name)
{
	if (-not (Test-Path $envFile)) { return '' }
	foreach ($line in Get-Content -Path $envFile)
	{
		if ($line -match ('^\s*' + $name + '\s*=\s*(.+)$')) { return $Matches[1].Trim().Trim('"') }
	}
	return ''
}

function Set-EnvValue([string]$name, [string]$value)
{
	if (-not (Test-Path $envFile)) { Set-Content -Path $envFile -Value ($name + '=' + $value); return }
	$replaced = $false
	$out = foreach ($line in Get-Content -Path $envFile)
	{
		if ($line -match ('^\s*' + $name + '\s*=')) { $replaced = $true; $name + '=' + $value }
		else { $line }
	}
	if ($replaced) { Set-Content -Path $envFile -Value $out }
	else { Add-Content -Path $envFile -Value ($name + '=' + $value) }
}

function Read-Log([string]$path)
{
	if (-not (Test-Path $path)) { return '' }
	try { return (Get-Content -Path $path -Raw) } catch { return '' }
}

if ($NoBuild -eq $false)
{
	Push-Location (Join-Path $root 'server')
	try { & go build -o $exe '.\cmd\starkflow' } finally { Pop-Location }
	if ($LASTEXITCODE -ne 0) { throw 'go build failed' }
}

if ([string]::IsNullOrWhiteSpace($Secret)) { $Secret = Get-EnvValue 'STARKFLOW_SECRET' }
if ([string]::IsNullOrWhiteSpace($Secret) -or $Secret -eq 'change-me-to-a-long-random-string')
{
	$bytes = New-Object byte[] 32
	[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
	$Secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
	Set-EnvValue 'STARKFLOW_SECRET' $Secret
	Write-Host 'generated STARKFLOW_SECRET and saved it to .env'
}

$serverLog = Join-Path $logDir 'server.log'
$serverErr = Join-Path $logDir 'server.err.log'
$tunnelLog = Join-Path $logDir 'tunnel.log'
$tunnelErr = Join-Path $logDir 'tunnel.err.log'

$env:STARKFLOW_SECRET = $Secret
$env:STARKFLOW_ADDR = ':' + $Port

function Test-Health([string]$base)
{
	try
	{
		$r = Invoke-WebRequest -UseBasicParsing -Uri ($base + '/health') -TimeoutSec 3
		return $r.StatusCode -eq 200
	}
	catch { return $false }
}

$localBase = 'http://127.0.0.1:' + $Port
$server = $null
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
{
	if (-not (Test-Health $localBase))
	{
		throw ('port ' + $Port + ' is taken by another program that does not answer /health. Free it with: ' +
			'$p = (Get-NetTCPConnection -LocalPort ' + $Port + ' -State Listen).OwningProcess; Stop-Process -Id $p -Force')
	}
	Write-Host ('port ' + $Port + ' is already served by StarkFlow, reusing it')
}
else
{
	$server = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden -RedirectStandardOutput $serverLog -RedirectStandardError $serverErr
	$up = $false
	for ($i = 0; $i -lt 40; $i++)
	{
		Start-Sleep -Milliseconds 250
		if (Test-Health $localBase) { $up = $true; break }
	}
	if ($up -eq $false)
	{
		Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
		throw ('the server did not start, see ' + $serverErr)
	}
	Write-Host ('server is up: http://localhost:' + $Port)
}

$cf = $null
$found = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($found) { $cf = $found.Source }
else
{
	$cf = Join-Path $PSScriptRoot 'bin\cloudflared.exe'
	if (-not (Test-Path $cf))
	{
		New-Item -ItemType Directory -Force -Path (Split-Path $cf) | Out-Null
		Write-Host 'downloading cloudflared...'
		Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cf
	}
}

Remove-Item -Path $tunnelLog, $tunnelErr -ErrorAction SilentlyContinue
if ([string]::IsNullOrWhiteSpace($TunnelToken))
{
	$cfArgs = @('tunnel', '--no-autoupdate', '--url', ('http://127.0.0.1:' + $Port))
}
else
{
	$cfArgs = @('tunnel', '--no-autoupdate', 'run', '--token', $TunnelToken)
}
$tunnel = Start-Process -FilePath $cf -ArgumentList $cfArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput $tunnelLog -RedirectStandardError $tunnelErr

if ($TunnelToken)
{
	Write-Host 'tunnel started with a token: the public hostname is the one set in Cloudflare Zero Trust'
}
else
{
	$public = ''
	for ($i = 0; $i -lt 120; $i++)
	{
		Start-Sleep -Milliseconds 500
		$m = [regex]::Match(((Read-Log $tunnelErr) + (Read-Log $tunnelLog)), 'https://[a-z0-9-]+\.trycloudflare\.com')
		if ($m.Success) { $public = $m.Value; break }
		if ($tunnel.HasExited) { break }
	}
	if (-not $public)
	{
		if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
		Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
		throw ('no public address in the tunnel log, see ' + $tunnelErr)
	}
	Write-Host ''
	Write-Host ('public address:    ' + $public)
	Write-Host ('plugin Server URL: wss://' + $public.Replace('https://', '') + '/ws')
	$publicOK = $false
	for ($i = 0; $i -lt 60; $i++)
	{
		if (Test-Health $public) { $publicOK = $true; break }
		Start-Sleep -Milliseconds 500
	}
	if ($publicOK)
	{
		Write-Host 'checked from the internet: /health answers ok'
	}
	else
	{
		Write-Host 'warning: the public address does not answer yet, see dist\logs\tunnel.err.log'
	}
}

Write-Host ''
Write-Host 'the server and the tunnel are running, press Ctrl+C to stop them'

try
{
	Wait-Process -Id $tunnel.Id
}
finally
{
	foreach ($p in @($tunnel, $server))
	{
		if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
	}
}
