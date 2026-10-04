param([string]$OutputPath = (Join-Path $PSScriptRoot 'corpus/official-raw.json'))
$ErrorActionPreference = 'Stop'
$orcEndpoint = 'https://herokuapi.kards.com/graphql'
$orcQuery = 'query getCards($language:String,$offset:Int,$showSpawnables:Boolean,$showReserved:Boolean,$showExiles:Boolean){cards(language:$language,first:100,offset:$offset,showSpawnables:$showSpawnables,showReserved:$showReserved,showExiles:$showExiles){pageInfo{count hasNextPage} edges{node{id cardId importId json reserved}}}}'
$orcCards = [System.Collections.Generic.List[object]]::new()
$orcSeen = [System.Collections.Generic.HashSet[string]]::new()
$orcCount = $null
for ($orcOffset=0; $orcOffset -lt 10000; $orcOffset+=100) {
  $orcBody = @{operationName='getCards';query=$orcQuery;variables=@{language='zh';offset=$orcOffset;showSpawnables=$true;showReserved=$true;showExiles=$true}} | ConvertTo-Json -Depth 10
  $orcResponse = $null
  for ($orcAttempt=0; $orcAttempt -lt 3; $orcAttempt++) {
    try {
      $orcResponse = Invoke-RestMethod -Uri $orcEndpoint -Method Post -ContentType application/json -Body $orcBody -TimeoutSec 20
      if ($orcResponse.errors) { throw ($orcResponse.errors | ConvertTo-Json -Compress -Depth 10) }
      break
    } catch { if ($orcAttempt -eq 2) { throw }; Write-Host "Retry page ${orcOffset}: $($_.Exception.Message)" }
  }
  $orcPage = $orcResponse.data.cards
  if (!$orcPage) { throw 'Official cards response missing' }
  if ($null -ne $orcCount -and $orcCount -ne $orcPage.pageInfo.count) { throw 'Collection changed during pagination; fetch again' }
  $orcCount = $orcPage.pageInfo.count
  foreach ($orcEdge in $orcPage.edges) { if ($orcSeen.Add([string]$orcEdge.node.id)) { $orcCards.Add($orcEdge.node) } }
  Write-Host "Official collection: $($orcCards.Count) / $orcCount"
  if (!$orcPage.pageInfo.hasNextPage) { break }
  if (!$orcPage.edges.Count) { throw 'Pagination ended before hasNextPage' }
}
if (!$orcCards.Count -or $orcCards.Count -ne $orcCount) { throw "Incomplete official collection: $($orcCards.Count)/$orcCount" }
$orcContent = @{source='https://www.kards.com/zh/decks/collection';endpoint=$orcEndpoint;retrievedAt=[DateTime]::UtcNow.ToString('o');reportedCount=$orcCount;includesReserve=$true;includesSpawnables=$true;includesExiles=$true;cards=$orcCards.ToArray()} | ConvertTo-Json -Depth 60
New-Item -ItemType Directory -Force (Split-Path -Parent $OutputPath) | Out-Null
[IO.File]::WriteAllText($OutputPath,$orcContent+"`n",[Text.UTF8Encoding]::new($false))
Write-Host "Saved $($orcCards.Count) cards, SHA256 $((Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash)"
