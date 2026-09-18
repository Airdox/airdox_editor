; airdox SMART Editor – Windows-Installationsziele (strikt Laufwerk D:).
;
; Standard-Installationsordner: D:\airdox_SMART_Editor\App
; (Quelle der Pfade: electron/windowsPaths.cjs, WINDOWS_APP_ROOT_DEFAULT)
;
; Verhalten:
; - Neuinstallation: strikt D:. Ohne D: (oder schreibgeschützt) bricht das
;   Setup mit klarer Meldung ab – es wird nichts auf C: installiert.
; - Update: Eine vorhandene InstallLocation aus der Registry wird beibehalten,
;   damit kein verwaistes Duplikat am alten Ort zurückbleibt. Wer von C: auf D:
;   wechseln will, deinstalliert einmal und installiert neu.
; - /D=... (Kommandozeile) und die Verzeichnisauswahl im Setup bleiben möglich.
;
; customInit läuft in .onInit NACH initMultiUser (das $INSTDIR vorbelegt) und
; VOR der Anzeige der Verzeichnisseite – also genau der richtige Hook.
; Es werden nur NSIS-Kernbefehle verwendet (kein LogicLib nötig).

!macro customInit
  ; 1. Explizites /D=... hat immer Vorrang. ($R0 wie in multiUser.nsh –
  ;    $R5-$R9 sind Scratch-Register von GetDParameter und scheiden aus.)
  !insertmacro GetDParameter $R0
  StrCmp $R0 "" airdox_no_d_param airdox_keep_cmdline
  airdox_keep_cmdline:
    StrCpy $INSTDIR $R0
    Goto airdox_check_drive

  ; 2. Update? Dann am bisherigen Ort bleiben.
  airdox_no_d_param:
  ReadRegStr $R0 HKCU "Software\${APP_GUID}" InstallLocation
  StrCmp $R0 "" airdox_fresh_install airdox_keep_previous
  airdox_keep_previous:
    StrCpy $INSTDIR $R0
    Goto airdox_check_drive

  ; 3. Neuinstallation -> strikt D:.
  airdox_fresh_install:
  StrCpy $INSTDIR "D:\airdox_SMART_Editor\App"

  ; Strikt: Ziel muss anlegbar/beschreibbar sein, sonst Abbruch mit Meldung.
  airdox_check_drive:
  ClearErrors
  CreateDirectory "$INSTDIR"
  IfErrors airdox_no_drive airdox_drive_ok

  airdox_no_drive:
  MessageBox MB_OK|MB_ICONSTOP "airdox SMART Editor kann nicht installiert werden.$\n$\nLaufwerk D: wurde nicht gefunden oder ist schreibgeschützt.$\n$\nBitte stelle sicher, dass Laufwerk D: verfügbar ist, und starte das Setup erneut."
  Abort

  airdox_drive_ok:
!macroend
