# Reproduzierbarer nativer SQLCipher-CI-Test

Der Workflow [`.github/workflows/master-db-sqlcipher.yml`](../.github/workflows/master-db-sqlcipher.yml)
trennt zwei bewusst unterschiedliche Testpfade:

1. `node tests/master-db-gate.test.mjs` bleibt der schnelle injectable
   Regressionstest. Sein `node:sqlite`-Treiber-Double wird nicht entfernt und
   ist **kein** Real-SQLCipher-Test.
2. `npm run test:masterdb:real` führt
   [`scripts/sqlcipher-native-gate.mjs`](../scripts/sqlcipher-native-gate.mjs)
   aus. Das Script lädt `better-sqlite3-multiple-ciphers` direkt, prüft eine
   echte verschlüsselte Datenbank mit richtigem und falschem Schlüssel und ruft
   anschließend `electron/masterDbGate.cjs` **ohne `deps.driver`-Injection** auf.

Im Log und im JSON-Report stehen unter anderem:

```text
REAL_NATIVE_SQLCIPHER = true
MASTER DB TEST DRIVER: REAL SQLCIPHER NATIVE
```

Der native Lauf ist nur erfolgreich, wenn alle folgenden Nachweise vorhanden
sind:

- Binding lässt sich nach einem erzwungenen Source-Build importieren.
- Eine temporäre synthetische `master.db` hat keinen Klartext-Header
  `SQLite format 3`.
- Der korrekte SQLCipher-Schlüssel kann Schema und Daten lesen.
- Ein falscher Schlüssel kann die verschlüsselte Schema-Abfrage nicht lesen.
- Das bestehende Master-DB-Gate findet `djmdContent`, fragt den Track ab und
  liefert die Trackdaten aus dem nativen Driver.
- Der Fingerabdruck der Datenbank bleibt unverändert.

## Synthetic vs. echte Rekordbox-Datenbank

Der normale Push-/Pull-Request-Lauf erzeugt ausschließlich eine temporäre,
synthetische SQLCipher-Datenbank. Sie enthält nur die für das vorhandene Gate
relevanten Rekordbox-artigen Tabellen `djmdContent`, `djmdCue` und
`djmdProperty`. Sie ist ein Test für:

```text
native SQLCipher + Öffnen + Schema + Query + Master-DB-Gate
```

Sie ist **nicht** der Nachweis, dass eine bestimmte private Rekordbox-
Bibliothek erfolgreich gelesen wurde. Keine echte `master.db`, keine Pfade und
keine persönlichen Metadaten werden in das Repository aufgenommen.

Für einen manuellen Lauf mit einem privaten Datensatz können Repository-
Maintainer im Actions-Workflow die Option `run_real_master_db` aktivieren. Dafür
müssen die Secrets `REKORDBOX_MASTER_DB_URL` und optional
`REKORDBOX_MASTER_DB_TOKEN` auf einen privaten HTTPS-Artefaktspeicher zeigen.
Die Datei wird nur unter `/tmp` geladen, nach dem Lauf gelöscht und nie als
Artifact hochgeladen. Eine `real_track_id` kann angegeben werden; bleibt sie
leer, wird die erste `djmdContent.ID` der privaten Datenbank verwendet. Der
Report dokumentiert dabei nur Gate-Zustände, nicht den Trackinhalt.

Lokal ist derselbe native Test mit einer privaten Datei möglich:

```bash
npm ci --include=optional
npm_config_build_from_source=true npm rebuild better-sqlite3-multiple-ciphers --build-from-source
npm run test:masterdb:real -- --db "/privat/pfad/master.db" --track 12345
```

## Plattformpfad-Regel

Die Produktionslogik in `electron/dbReader.cjs` und `electron/masterDbGate.cjs`
bleibt unverändert: Rekordbox-Datenbanken werden unter Windows weiterhin über
die vorhandene Suche einschließlich `D:\` gefunden. Der synthetische CI-Test
verwendet dagegen einen Linux-Temp-Pfad und testet damit nur die native
Datenbank- und Gate-Kette, nicht die Windows-Laufwerkssuche.

Die CI-Reports liegen nur im Actions-Artifact `sqlcipher-native-gate-*` und
werden nicht als `ci-artifacts/` eingecheckt.
