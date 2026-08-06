; Inno Setup script — arb-desktop Windows installer
; Compile with Inno Setup after running build_windows.py

#define MyAppName "arb-desktop"
#define MyAppVersion "1.4.0"
#define MyAppPublisher "arb-desktop"
#define MyAppExeName "ArbDesktop.exe"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
OutputDir=installer
OutputBaseFilename=arb-desktop-setup-{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "dist\ArbDesktop\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{commondesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "arb-desktop 실행"; Flags: nowait postinstall skipifsilent
