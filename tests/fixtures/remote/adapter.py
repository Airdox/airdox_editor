"""Protocol fixture, NOT trained separation. Deliberately uses production names/FLOAT WAV."""
import json
import os
from pathlib import Path
import struct
import sys
import time

def arg(name):
    return sys.argv[sys.argv.index(name) + 1]
mode = os.environ.get('AIRDOX_TEST_ADAPTER_MODE', 'ok')
if mode == 'silent':
    time.sleep(60)
if mode == 'error':
    print(json.dumps(dict(type='error', code='MODEL_CORRUPT', message='fixture error')), flush=True)
    sys.exit(2)
if mode == 'no-done':
    sys.exit(0)
if mode == 'stderr':
    for _ in range(2000):
        sys.stderr.write('x' * 1024 + '\n')
    sys.stderr.flush()
source = bytearray(Path(arg('--input')).read_bytes())
pos = 12
while pos + 8 <= len(source):
    tag, size = struct.unpack_from('<4sI', source, pos)
    pos += 8
    if tag == b'data':
        for i in range(pos, pos + size, 4):
            value = struct.unpack_from('<f', source, i)[0]
            struct.pack_into('<f', source, i, value / 4)
        break
    pos += size + size % 2
out = Path(arg('--output-dir'))
out.mkdir(parents=True, exist_ok=True)
stems = []
for i, name in enumerate(arg('--stems').split(',')):
    target = out / f'stem_{i}_{name}.wav'
    target.write_bytes(source)
    stems.append(dict(name=name, index=i, path=str(target.resolve())))
print(json.dumps(dict(type='progress', fraction=1, phase='fixture complete')), flush=True)
print(json.dumps(dict(type='done', device='cpu', stems=stems, report={'fixture': True})), flush=True)
