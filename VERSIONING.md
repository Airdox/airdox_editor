# Versionierung

Dieses Projekt verwendet **kein** SemVer, sondern ein bewusst einfaches
Zwei-Teile-Schema:

```
GANZE_ZAHL.NACHKOMMASTELLE
```

Beispiele: `0.1`, `0.2`, `0.9`, `1.0`, `1.1`, …

## Regeln

1. **Normale Änderung** (Feature, Fix, Refactoring, Doku):
   Die Nachkommastelle wird um `1` erhöht.
   `0.2` → `0.3` → `0.4` …

2. **Große Änderung** (Rebranding, Architekturbruch, neue Produktstufe):
   Die ganze Zahl wird um `1` erhöht und die Nachkommastelle auf `0` gesetzt.
   `0.7` → `1.0`

Es gibt kein Limit bei `.9` — auf `0.9` kann `0.10` folgen, wenn kein großer
Sprung ansteht. Der Wechsel auf die nächste ganze Zahl ist immer eine
bewusste Entscheidung, kein Automatismus.

## Technische Schreibweise

`package.json` und Electron-Builder verlangen ein dreistelliges Format.
Deshalb wird die Version dort mit einer angehängten `.0` geschrieben —
die dritte Stelle ist **immer `0`** und hat keine Bedeutung:

| Konzeptuelle Version | package.json |
| -------------------- | ------------ |
| `0.1`                | `0.1.0`      |
| `0.2`                | `0.2.0`      |
| `1.0`                | `1.0.0`      |
| `1.3`                | `1.3.0`      |

Eine Version wie `0.2.1` darf **nicht** vergeben werden.

## Single Source of Truth

Die Version steht ausschließlich in `package.json`. Vite injiziert sie beim
Build als `__APP_VERSION__` (siehe `vite.config.ts`), `src/version.ts`
exportiert sie an die UI (Titelleiste und Hilfe → Über).

## Ablauf bei einem Release

1. Version in `package.json` nach obigen Regeln erhöhen.
2. Neuen Abschnitt in `CHANGELOG.md` ergänzen.
3. Committen, z. B. `chore(release): 0.3`.
