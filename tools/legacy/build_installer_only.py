import os, subprocess, shutil
print('Starte reinen Setup-Build...')
subprocess.check_call(['pyinstaller', 'build.spec', '--clean'])
if os.path.exists('C:/Program Files (x86)/Inno Setup 6/ISCC.exe'):
    subprocess.check_call(['C:/Program Files (x86)/Inno Setup 6/ISCC.exe', 'setup.iss'])
print('Portable Rohdaten werden bereinigt, sodass nur das Setup übrig bleibt...')
if os.path.exists('dist/DJ_Airdox_Editor'):
    shutil.rmtree('dist/DJ_Airdox_Editor')
print('Setup-Build abgeschlossen. Nur noch die Setup-Datei ist vorhanden.')

