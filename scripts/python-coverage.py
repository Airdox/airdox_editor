"""All-inventory Python coverage, using an already installed coverage.py.
python scripts/python-coverage.py <reports/coverage-snapshot-...>
No model execution: only mocked Top200 tests and the worker's built-in self-test.
"""
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys
import time
import coverage

sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
root = Path(__file__).resolve().parents[1]
os.chdir(root)
output = Path(sys.argv[1]).resolve()
manifest = json.loads((output / 'coverage-inventory.json').read_text(encoding='utf-8'))
files = manifest['pythonFiles']
before = {file: hashlib.sha256((root / file).read_bytes()).hexdigest() for file in files}
cov = coverage.Coverage(branch=True, source=['colab', 'python', 'tools'], data_file=str(output / 'coverage-python.dat'))
results = []
cov.start()
for file, args in [('tests/top200_batch_test.py', []), ('colab/remote_worker.py', ['--self-test'])]:
    started = time.monotonic()
    sys.argv = [file] + args
    code = 0
    error = None
    try:
        runpy.run_path(str(root / file), run_name='__main__')
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else (1 if exc.code else 0)
    except Exception as exc:
        code = 1
        error = repr(exc)
    results.append({'file': file, 'args': args, 'exitCode': code, 'error': error, 'durationSeconds': time.monotonic() - started})
cov.stop()
cov.save()
# Explicit morfs guarantee every inventoried file, even non-package scripts,
# participates with executable-line and branch denominators when never loaded.
morfs = [str(root / file) for file in files]
cov.json_report(morfs=morfs, outfile=str(output / 'coverage-python.json'))
cov.report(morfs=morfs)
data = json.loads((output / 'coverage-python.json').read_text(encoding='utf-8'))
reported = sorted(file.replace('\\', '/') for file in data['files'])
after = {file: hashlib.sha256((root / file).read_bytes()).hexdigest() for file in files}
report = {'coverageVersion': coverage.__version__, 'python': sys.version, 'executable': sys.executable,
          'results': results, 'inventoryFiles': files, 'reportedFiles': reported,
          'missingFiles': sorted(set(files) - set(reported)), 'unexpectedFiles': sorted(set(reported) - set(files)),
          'sha256Before': before, 'sha256After': after,
          'changedDuringCapture': [file for file in files if before[file] != after[file]],
          'totals': data['totals'], 'wholeProjectCoverage': None}
(output / 'coverage-python-reconciliation.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, indent=2))
sys.exit(1 if any(result['exitCode'] for result in results) else 0)
