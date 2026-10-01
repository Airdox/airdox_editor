[Setup]
AppName=DJ Airdox Editor
AppVersion=1.0
DefaultDirName={autopf}\DJ Airdox Editor
DefaultGroupName=DJ Airdox Editor
OutputDir=dist_installer
OutputBaseFilename=DJ_Airdox_Editor_Setup
Compression=lzma
SolidCompression=yes

[Files]
Source: "dist\DJ_Airdox_Editor\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\DJ Airdox Editor"; Filename: "{app}\DJ_Airdox_Editor.exe"
Name: "{autodesktop}\DJ Airdox Editor"; Filename: "{app}\DJ_Airdox_Editor.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

