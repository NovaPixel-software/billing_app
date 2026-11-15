# Generates one WAV per narration line using Windows' built-in offline text-to-speech.
# usage: powershell -File make_voice.ps1 -Json narration.json -OutDir voice [-Voice "Microsoft Zira Desktop"] [-Rate 0]
param([string]$Json, [string]$OutDir, [string]$Voice = "Microsoft Zira Desktop", [int]$Rate = 0)
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$lines = Get-Content -Raw -Encoding UTF8 $Json | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice($Voice)
$synth.Rate = $Rate
$i = 0
$index = @{}
foreach ($p in $lines.PSObject.Properties) {
  $i++
  $file = Join-Path $OutDir ("v{0:D2}.wav" -f $i)
  $synth.SetOutputToWaveFile($file)
  $synth.Speak($p.Value)
  $index[$p.Name] = ("v{0:D2}.wav" -f $i)
}
$synth.SetOutputToNull()
$index | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $OutDir "index.json")
Write-Output "generated $i clips"
