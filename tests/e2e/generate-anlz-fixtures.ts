import { writeFileSync } from 'node:fs';
import { generateRealAnlzDatFixture, generateRealAnlzExtFixture } from '../fixtures/testDatasets';

const dat = Buffer.from(generateRealAnlzDatFixture(128));
const ext = Buffer.from(generateRealAnlzExtFixture(128));
writeFileSync('/tmp/e2e/ANLZ0000.DAT', dat);
writeFileSync('/tmp/e2e/ANLZ0000.EXT', ext);
console.log('DAT bytes:', dat.length, 'EXT bytes:', ext.length);
