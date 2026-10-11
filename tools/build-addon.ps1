# Builds dist/starkflow.c3addon from the sources in plugin/.
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools/build-addon.ps1
#
# The addon is a zip that must contain addon.json at its root, so every file is
# added with a path relative to plugin/ and with forward slashes.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'plugin'
$out = Join-Path (Join-Path $root 'dist') 'starkflow.c3addon'

if (-not (Test-Path (Join-Path $src 'addon.json'))) { throw "addon.json not found in $src" }
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
if (Test-Path $out) { Remove-Item $out }

$archive = [System.IO.Compression.ZipFile]::Open($out, 'Create')
try
{
	# *.c3addon под plugin/ — это случайные копии готового аддона; внутрь архива они
	# попадать не должны, иначе в собранном .c3addon лежит лишний устаревший архив.
	foreach ($f in Get-ChildItem -Path $src -Recurse -File | Where-Object { $_.Extension -ne '.c3addon' })
	{
		$rel = $f.FullName.Substring($src.Length + 1).Replace('\', '/')
		[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $f.FullName, $rel) | Out-Null
	}
}
finally
{
	$archive.Dispose()
}
"built $out ($((Get-Item $out).Length) bytes)"
