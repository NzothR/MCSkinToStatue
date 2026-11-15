param([string]$JdkPath = 'D:\CustomLib\zulu25.28.85-ca-jdk25.0.0-win_x64')
$ErrorActionPreference = 'Stop'
# 仅为本次构建设置 Java 和缓存目录，不修改系统 JAVA_HOME。
$env:JAVA_HOME = $JdkPath
$env:GRADLE_USER_HOME = Join-Path $PSScriptRoot '..\.cache\gradle'
$env:TEMP = Join-Path $PSScriptRoot '..\.cache\java-tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:GRADLE_USER_HOME, $env:TEMP | Out-Null
Push-Location $PSScriptRoot
try {
    & .\gradlew.bat --no-daemon assemble -x test
    if ($LASTEXITCODE -ne 0) { throw "Gradle build failed: $LASTEXITCODE" }
    $artifact = Join-Path $PSScriptRoot 'build\libs\skinstatueindex-0.1.2.jar'
    $outputDirectory = Join-Path $PSScriptRoot '..\output'
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
    Copy-Item -LiteralPath $artifact -Destination $outputDirectory
} finally {
    Pop-Location
}
