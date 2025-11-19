# 1. Configuration
$outputFileName = "combined_project_code.txt"
$targetFolders = @("utils", "tools", "schemas")
$rootPath = $PWD.Path

# 2. Reset Output File
# We create a blank file immediately so you can see it exists.
New-Item -Path "$rootPath\$outputFileName" -ItemType File -Force | Out-Null

Write-Host "--------------------------------------------------"
Write-Host "Starting script (Fixed Recursive Version)"
Write-Host "Output: $rootPath\$outputFileName"
Write-Host "--------------------------------------------------"

# 3. Outer Loop: Iterate through folder names
foreach ($folderName in $targetFolders) {
    $fullFolderPath = Join-Path $rootPath $folderName

    # Check if folder exists
    if (-not (Test-Path $fullFolderPath)) {
        Write-Host "Warning: Folder '$folderName' not found in $rootPath" -ForegroundColor Yellow
        continue
    }

    # FIX: Added -Recurse. This ensures -Include works as expected.
    $files = Get-ChildItem -Path $fullFolderPath -Recurse -Include *.js, *.ts -File

    if ($files.Count -eq 0) {
        Write-Host "  -> No .js or .ts files found in $folderName" -ForegroundColor DarkGray
    }

    # 4. Inner Loop: Iterate through the files found
    foreach ($file in $files) {
        
        # Calculate relative path
        $relativePath = $file.FullName.Replace("$rootPath\", "")

        Write-Host "  -> Including: $relativePath" -ForegroundColor Green

        # Append Header
        "### START FILE: $relativePath ###`r`n" | Out-File -Append $outputFileName -Encoding UTF8

        # Append Content
        Get-Content $file.FullName | Out-File -Append $outputFileName -Encoding UTF8

        # Append Footer
        "`r`n### END FILE: $relativePath ###`r`n`r`n" | Out-File -Append $outputFileName -Encoding UTF8
    }
}

Write-Host "--------------------------------------------------"
Write-Host "Done."
Write-Host "--------------------------------------------------"