import json
import pathlib
import subprocess
import sys
import threading
import time

binary = pathlib.Path(sys.argv[1]).resolve()
out = pathlib.Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
log = (out / 'benchmark.log').open('w')
process = subprocess.Popen([str(binary), '--benchmark'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
print(f'PID={process.pid}', flush=True)
phase = 'setup'
samples = []
def logs():
    global phase
    for line in process.stdout:
        log.write(line)
        log.flush()
        print(line.rstrip(), flush=True)
        if 'BENCHMARK_IDLE' in line:
            phase = 'idle'
        elif 'BENCHMARK_UPLOAD_START' in line:
            phase = 'upload'
        elif 'BENCHMARK_UPLOAD_DONE' in line:
            phase = 'after-upload'
reader = threading.Thread(target=logs)
reader.start()
started = time.monotonic()
while process.poll() is None and time.monotonic() - started < 150:
    result = subprocess.run(['ps', '-o', 'rss=', '-p', str(process.pid)], capture_output=True, text=True)
    if result.stdout.strip():
        samples.append({'seconds': round(time.monotonic()-started, 2), 'phase': phase, 'rss_bytes': int(result.stdout)*1024})
    if phase in ('idle', 'upload', 'after-upload'):
        target = out / f'footprint-{phase}.json'
        if not target.exists():
            subprocess.run(['footprint', '-p', str(process.pid), '-j', str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.1)
if process.poll() is None:
    process.terminate()
reader.join(timeout=10)
log.close()
completed = 'BENCHMARK_DONE' in (out / 'benchmark.log').read_text() and 'BENCHMARK_FAILED' not in (out / 'benchmark.log').read_text()
report = {'completed': completed, 'metric': 'RSS bytes from ps (not Activity Monitor physical footprint)', 'exit_code': process.wait(), 'samples': samples, 'summary': {}}
for label in ('idle', 'upload', 'after-upload'):
    values = sorted(s['rss_bytes'] for s in samples if s['phase']==label)
    if values:
        report['summary'][label] = {'median_bytes': values[len(values)//2], 'max_bytes': max(values), 'samples': len(values)}
(out/'memory.json').write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(report['summary']), flush=True)

sys.exit(0 if completed and report["exit_code"] == 0 else 1)
