#!/usr/bin/env python3
"""Erzeugt die SQLCipher-Test-Fixtures für den reinen JS-Datenbankleser.

Die Dateien in tests/fixtures/ werden eingecheckt, damit `npm test` weder
SQLCipher noch einen C-Compiler braucht. Dieses Skript wird nur benoetigt,
wenn das Schema oder die Schluessel-Einstellungen geaendert werden:

    python3 -m venv .venv-sqlcipher && .venv-sqlcipher/bin/pip install sqlcipher3-binary
    .venv-sqlcipher/bin/python tools/generate-sqlcipher-fixtures.py

Es werden ausschliesslich kuenstliche Daten geschrieben - echte Rekordbox-
Bibliotheken werden von diesem Skript nie gelesen oder veraendert.
"""

import os
import sys

from sqlcipher3 import dbapi2 as sqlcipher

FIXTURE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tests', 'fixtures')

# Die von der Community entschluesselten, fest eingebauten Passphrasen.
MASTER_DB_KEY = '402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497'
ONE_LIBRARY_KEY = 'r8gddnr4k847830ar6cqzbkk0el6qytmb3trbbx805jm74vez64i5o8fnrqryqls'

# SQLCipher-Version 4 (PRAGMA legacy = 4) - Standard bei Rekordbox 6/7.
V4_SETTINGS = [
    'PRAGMA cipher_page_size = 4096;',
    'PRAGMA kdf_iter = 256000;',
    'PRAGMA cipher_use_hmac = ON;',
    'PRAGMA cipher_hmac_algorithm = HMAC_SHA512;',
    'PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA512;',
]

# SQLCipher-Version 3 (PRAGMA legacy = 3) -aeltere Exporte / Geraete-Bibliotheken.
V3_SETTINGS = [
    'PRAGMA cipher_page_size = 1024;',
    'PRAGMA kdf_iter = 64000;',
    'PRAGMA cipher_use_hmac = ON;',
    'PRAGMA cipher_hmac_algorithm = HMAC_SHA1;',
    'PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA1;',
]

MASTER_DB_SCHEMA = """
CREATE TABLE IF NOT EXISTS djmdArtist (ID INTEGER PRIMARY KEY, Name TEXT);
CREATE TABLE IF NOT EXISTS djmdAlbum (ID INTEGER PRIMARY KEY, Name TEXT, ArtistID INTEGER);
CREATE TABLE IF NOT EXISTS djmdGenre (ID INTEGER PRIMARY KEY, Name TEXT);
CREATE TABLE IF NOT EXISTS djmdKey (ID INTEGER PRIMARY KEY, Seq INTEGER, ScaleName TEXT);
CREATE TABLE IF NOT EXISTS djmdLabel (ID INTEGER PRIMARY KEY, Name TEXT);
CREATE TABLE IF NOT EXISTS djmdContent (
  ID INTEGER PRIMARY KEY, FolderPath TEXT, FileNameL TEXT, Title TEXT, ArtistID INTEGER,
  AlbumID INTEGER, GenreID INTEGER, BPM INTEGER, Length INTEGER, TrackNo INTEGER, BitRate INTEGER,
  BitDepth INTEGER, Commnt TEXT, FileType INTEGER, Rating INTEGER, ReleaseYear INTEGER, RemixerID INTEGER,
  LabelID INTEGER, KeyID INTEGER, StockDate TEXT, ColorID INTEGER, DJPlayCount INTEGER, AnalysisDataPath TEXT,
  FileSize INTEGER, SampleRate INTEGER, DateCreated TEXT, ReleaseDate TEXT, ISRC TEXT, Subtitle TEXT,
  ComposerID INTEGER
);
CREATE TABLE IF NOT EXISTS djmdCue (
  ID INTEGER PRIMARY KEY, ContentID INTEGER, InMsec INTEGER, InFrame INTEGER, OutMsec INTEGER,
  OutFrame INTEGER, Kind INTEGER, Color INTEGER, ColorTableIndex INTEGER, ActiveLoop INTEGER,
  Comment TEXT, BeatLoopSize INTEGER
);
CREATE TABLE IF NOT EXISTS djmdPlaylist (ID INTEGER PRIMARY KEY, Name TEXT, ParentID INTEGER, Attribute INTEGER);
CREATE TABLE IF NOT EXISTS djmdSongPlaylist (ID INTEGER PRIMARY KEY, PlaylistID INTEGER, ContentID INTEGER, TrackNo INTEGER);
"""

MASTER_DB_DATA = """
INSERT INTO djmdArtist VALUES (1,'Klangform');
INSERT INTO djmdArtist VALUES (2,'Zwilling & Brüder');
INSERT INTO djmdAlbum VALUES (2,'Nacht Schichten',1);
INSERT INTO djmdGenre VALUES (3,'Melodic House');
INSERT INTO djmdKey VALUES (4,1,'8A');
INSERT INTO djmdLabel VALUES (5,'Airdox Records');
INSERT INTO djmdContent (ID,FolderPath,FileNameL,Title,ArtistID,AlbumID,GenreID,BPM,Length,TrackNo,BitRate,BitDepth,Commnt,FileType,Rating,ReleaseYear,LabelID,KeyID,StockDate,ColorID,DJPlayCount,AnalysisDataPath,FileSize,SampleRate,ISRC,Subtitle)
  VALUES (101,'C:\\Music\\Rekordbox','Obsidian Voltage.wav','Obsidian Voltage (Club Mix)',1,2,3,12800,240000,1,320,24,'Peak hour',1,255,2025,5,4,'2026-01-04 18:22:10',3,18,'C:\\Users\\dj\\AppData\\Roaming\\Pioneer\\rekordbox6\\ANLZ\\0000000A.DAT',36864044,44100,'DE-A9O-25-00142','Original Mix');
INSERT INTO djmdContent (ID,FolderPath,FileNameL,Title,ArtistID,AlbumID,GenreID,BPM,Length,TrackNo,FileType,Rating,ReleaseYear,KeyID,DJPlayCount,SampleRate)
  VALUES (102,'C:\\Music\\Rekordbox','Tiefebass.mp3','Tiefebass',2,2,3,12400,186000,2,2,128,2024,4,3,44100);
INSERT INTO djmdCue (ID,ContentID,InMsec,InFrame,OutMsec,OutFrame,Kind,Color,ColorTableIndex,ActiveLoop,Comment,BeatLoopSize)
  VALUES (1,101,0,0,-1,-1,0,0,0,0,'Start',0);
INSERT INTO djmdCue (ID,ContentID,InMsec,InFrame,OutMsec,OutFrame,Kind,Color,ColorTableIndex,ActiveLoop,Comment,BeatLoopSize)
  VALUES (2,101,7500,0,-1,-1,1,5,0,0,'Drop',0);
INSERT INTO djmdCue (ID,ContentID,InMsec,InFrame,OutMsec,OutFrame,Kind,Color,ColorTableIndex,ActiveLoop,Comment,BeatLoopSize)
  VALUES (3,101,15000,0,46875,0,8,7,0,1,'Build-Loop',4);
INSERT INTO djmdCue (ID,ContentID,InMsec,InFrame,OutMsec,OutFrame,Kind,Color,ColorTableIndex,ActiveLoop,Comment,BeatLoopSize)
  VALUES (4,101,60000,0,-1,-1,2,4,0,0,'Break',0);
INSERT INTO djmdPlaylist VALUES (9,'Prime Time',-1,0);
INSERT INTO djmdSongPlaylist VALUES (1,9,101,1);
"""

ONE_LIBRARY_SCHEMA = """
CREATE TABLE IF NOT EXISTS artist (artist_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS album (album_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS genre (genre_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS key (key_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS label (label_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS content (
  content_id INTEGER PRIMARY KEY, title TEXT, artist_id_artist INTEGER, album_id INTEGER, genre_id INTEGER,
  key_id INTEGER, label_id INTEGER, bpmx100 INTEGER, length INTEGER, path TEXT, fileName TEXT,
  samplingRate INTEGER, fileSize INTEGER, rating INTEGER, djComment TEXT, dateAdded TEXT, isrc TEXT,
  releaseYear TEXT, analysisDataFilePath TEXT
);
CREATE TABLE IF NOT EXISTS cue (
  cue_id INTEGER PRIMARY KEY, content_id INTEGER, inUsec INTEGER, outUsec INTEGER, kind INTEGER,
  cueComment TEXT, isActiveLoop INTEGER, color INTEGER
);
CREATE TABLE IF NOT EXISTS playlist (playlist_id INTEGER PRIMARY KEY, name TEXT, playlist_id_parent INTEGER, attribute INTEGER);
CREATE TABLE IF NOT EXISTS playlist_content (playlist_content_id INTEGER PRIMARY KEY, playlist_id INTEGER, content_id INTEGER, sequenceNo INTEGER);
"""

ONE_LIBRARY_DATA = """
INSERT INTO artist VALUES (1,'Zwilling');
INSERT INTO album VALUES (2,'Nacht Schichten');
INSERT INTO genre VALUES (3,'Melodic House');
INSERT INTO key VALUES (4,'8A');
INSERT INTO label VALUES (5,'Airdox Records');
INSERT INTO content VALUES (7,'Neon Glut',1,2,3,4,5,12650,212340000,'/media/usb/PIONEER/rekordbox/Neon Glut.mp3','Neon Glut.mp3',44100,12000000,4,'USB-Ready','2026-02-01 10:00:00','DE-A9O-24-00001','2024','/media/usb/PIONEER/rekordbox/ANLZ/0000000B.DAT');
INSERT INTO cue VALUES (1,7,0,-1,0,'Start',0,0);
INSERT INTO cue VALUES (2,7,32000000,-1,1,'Go',0,2);
INSERT INTO cue VALUES (3,7,64000000,95238000,8,'Loop 4',1,3);
INSERT INTO playlist VALUES (3,'USB Set',-1,0);
INSERT INTO playlist_content VALUES (1,3,7,1);
"""


def write_db(name, key, settings, schema, data, plaintext=False):
    path = os.path.join(FIXTURE_DIR, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        os.remove(path)
    if plaintext:
        import sqlite3
        conn = sqlite3.connect(path)
    else:
        conn = sqlcipher.connect(path)
        conn.execute("PRAGMA key = '%s';" % key)
        for pragma in settings:
            conn.execute(pragma)
    for statement in schema.split(';'):
        if statement.strip():
            conn.execute(statement)
    for statement in data.split(';'):
        if statement.strip():
            conn.execute(statement)
    conn.commit()
    conn.close()
    size = os.path.getsize(path)
    print('  geschrieben: %s (%d Bytes)' % (name, size))


def main():
    os.makedirs(FIXTURE_DIR, exist_ok=True)
    print('SQLCipher-Fixtures werden erzeugt ...')
    # Die Dateinamen entsprechen den echten Rekordbox-Dateien, weil der Leser
    # den Datenbanktyp über den Dateinamen erkennt.
    write_db(os.path.join('rekordbox6', 'master.db'), MASTER_DB_KEY, V4_SETTINGS, MASTER_DB_SCHEMA, MASTER_DB_DATA)
    write_db(os.path.join('onelibrary', 'exportLibrary.db'), ONE_LIBRARY_KEY, V4_SETTINGS, ONE_LIBRARY_SCHEMA, ONE_LIBRARY_DATA)
    write_db(os.path.join('legacy-v3', 'master.db'), MASTER_DB_KEY, V3_SETTINGS, MASTER_DB_SCHEMA, MASTER_DB_DATA)
    write_db(os.path.join('plaintext', 'master.db'), None, [], MASTER_DB_SCHEMA, MASTER_DB_DATA, plaintext=True)
    print('Fertig.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
