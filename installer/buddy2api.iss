; buddy2api - Windows installer script (Inno Setup 6)
; Built by installer\build.ps1: it stages installer\payload\ then runs ISCC.
;
; Install mode: per-user (no admin needed) -> %LOCALAPPDATA%\Programs\buddy2api
; Post-install: creates shortcuts, then launches the onboarding wizard
;               (login -> start service -> optional autostart/checkin).

#define AppName "buddy2api"
#ifndef AppVersion
#define AppVersion "1.0.0"
#endif

[Setup]
AppId={{ED688691-B69F-4897-B691-B25600454E18}}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppName}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
PrivilegesRequired=lowest
SetupIconFile=payload\assets\buddy2api.ico
UninstallDisplayIcon={app}\assets\buddy2api.ico
OutputDir=dist
OutputBaseFilename=buddy2api-setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=classic
WizardSmallImageFile=toolchain\innosetup-portable\bin\WizClassicSmallImage.bmp
DisableProgramGroupPage=yes
ShowLanguageDialog=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "toolchain\ChineseSimplified.isl"

[Files]
Source: "payload\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion replacesameversion

[Dirs]
; user data lives inside the app dir (data\accounts, token-usage.jsonl);
; created here so it survives even if the app is never started
Name: "{app}\data"

[Icons]
Name: "{group}\卸载 {#AppName}"; Filename: "{uninstallexe}"

[Run]
; shortcuts: desktop single entry + start menu actions (single source of truth)
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\install-shortcuts.ps1"""; \
  Flags: runhidden
; onboarding wizard (untick to skip; skipped entirely on silent installs)
Filename: "{app}\runtime\node.exe"; Parameters: "scripts\onboarding.js"; \
  WorkingDir: "{app}"; \
  Description: "立即配置：登录账号并启动服务"; \
  Flags: postinstall skipifsilent runasoriginaluser

[UninstallRun]
; stop service, kill leftover backends, remove tasks + shortcuts (keeps data\)
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\uninstall.ps1"""; \
  Flags: runhidden; RunOnceId: "UninstallCleanup"

[Code]
// Upgrades over a running instance: stop it first, otherwise node.exe and
// backend data files are locked and Windows asks for a reboot.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  rc: Integer;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\runtime\node.exe')) then
    Exec(ExpandConstant('{app}\runtime\node.exe'),
      ExpandConstant('scripts\service.js stop'), ExpandConstant('{app}'),
      SW_HIDE, ewWaitUntilTerminated, rc);
end;
