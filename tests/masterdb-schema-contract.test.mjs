/** Read-only master.db schema inspection contract (SQLCipher DB object double). */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { inspectDbSchema } = require('../electron/dbReader.cjs');

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const queries = [];
const columns = {
  djmdContent: ['ID', 'FolderPath', 'FileNameL', 'FileNameS', 'Title', 'ArtistID', 'AlbumID', 'GenreID', 'BPM', 'Length', 'AnalysisDataPath'],
  djmdCue: ['ID', 'ContentID', 'InMsec', 'InFrame', 'InMpegFrame', 'InMpegAbs', 'OutMsec', 'OutFrame', 'OutMpegFrame', 'OutMpegAbs', 'Kind', 'Color', 'ColorTableIndex', 'ActiveLoop', 'Comment'],
  djmdProperty: ['ID', 'DBVersion', 'DBID'],
  djmdArtist: ['ID', 'Name'], djmdAlbum: ['ID', 'Name'], djmdGenre: ['ID', 'Name'],
  djmdKey: ['ID', 'ScaleName'], djmdLabel: ['ID', 'Name'], djmdPlaylist: ['ID', 'Name'],
  djmdSongPlaylist: ['ID', 'PlaylistID', 'ContentID'],
};
const db = {
  prepare(sql) {
    queries.push(sql);
    return {
      all() {
        if (sql.includes('sqlite_master')) {
          return [
            ...Object.keys(columns).map((name) => ({ type: 'table', name, tbl_name: name })),
            { type: 'index', name: 'idx_djmdContent_id', tbl_name: 'djmdContent' },
          ];
        }
        const pragma = sql.match(/PRAGMA table_info\("([^"]+)"\)/);
        if (pragma) return columns[pragma[1]].map((name) => ({ name }));
        if (/FROM "djmdProperty"/.test(sql)) return [{ DBVersion: 7, DBID: 'fixture-db-id' }];
        throw new Error(`unexpected read query: ${sql}`);
      },
    };
  },
};

console.log('MASTER.DB SCHEMA READ-ONLY CONTRACT');
const schema = inspectDbSchema(db);
for (const table of Object.keys(columns)) assert(schema.tables.includes(table), `${table} is enumerated from sqlite_master`);
assert(schema.columns.djmdContent.includes('AnalysisDataPath'), 'djmdContent.AnalysisDataPath inspected');
assert(schema.columns.djmdCue.includes('InMsec'), 'djmdCue time columns inspected');
assert(schema.indexes.djmdContent.includes('idx_djmdContent_id'), 'indices inspected');
assert(schema.properties.DBVersion === 7 && schema.properties.DBID === 'fixture-db-id', 'DBVersion/DBID read from djmdProperty');
assert(queries.every((sql) => /^SELECT\b/i.test(sql) || /^PRAGMA\b/i.test(sql)), 'schema inspection issues only SELECT/PRAGMA, never write SQL');
console.log('PASS  sqlite_master, tables, columns, indexes, DBVersion/DBID; read-only queries only');
