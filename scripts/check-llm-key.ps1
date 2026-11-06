# ASCII-only forwarder: the real logic lives in check-llm-key.mjs (Node reads UTF-8 natively).
# Windows PowerShell 5.1 reads BOM-less UTF-8 .ps1 as GBK, so keep this file English-only.
node "$PSScriptRoot\check-llm-key.mjs"
