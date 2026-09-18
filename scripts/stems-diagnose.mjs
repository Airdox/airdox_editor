#!/usr/bin/env node
// Wrapper for stems:diagnose – tries tsx, falls back to node with --loader tsx
import { spawn } from 'node:child_process';
import path from 'node:path';

const script = path.join(import.meta.dirname, 'stems-diagnose.ts');
const child = spawn('npx', ['tsx', script], { stdio: 'inherit', env: process.env });
child.on('close', (code) => process.exit(code ?? 0));
child.on('error', () => {
  console.error('Failed to run tsx – try: npm install -g tsx');
  process.exit(1);
});
