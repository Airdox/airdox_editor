"""Exercise real worker protocol with an explicit test adapter; never reports readiness."""
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'colab'))
from remote_worker import JobStore, run_job
store = JobStore(sys.argv[1], 'python-protocol-fixture')
failed = False
for job in store.list_job_ids():
    result = run_job(store, job, store.read_manifest(job), model_dir=sys.argv[2], device='cpu',
                     adapter=str(Path(__file__).with_name('adapter.py')), work_dir=sys.argv[2],
                     sync_timeout=0.2, timeout=10, idle_timeout=5, heartbeat_interval=0.1)
    failed |= result == 'failed'
sys.exit(1 if failed else 0)
