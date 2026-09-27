#!/usr/bin/env python3
"""Start/stop only the isolated local GBrain HTTP process; never system services."""
import json, os, pathlib, signal, subprocess, sys, time, urllib.request
ROOT = pathlib.Path(os.environ.get('GLANCE_GBRAIN_RUNTIME', pathlib.Path.home()/'.local/share/glance-qm/gbrain-runtime'))
PID = ROOT/'server.pid'
HOST = pathlib.Path(__file__).resolve().with_name('gbrain-host.sh')
CONFIG = json.loads((ROOT/'service.json').read_text()) if (ROOT/'service.json').exists() else {}
PORT = int(CONFIG.get('port', 3131))
BASE = f'http://127.0.0.1:{PORT}'
def healthy():
    try:
        with urllib.request.urlopen(BASE+'/health', timeout=2) as r:
            return json.load(r).get('engine') == 'postgres'
    except Exception: return False
action = sys.argv[1] if len(sys.argv)>1 else 'status'
if action == 'start':
    if healthy(): print('GBrain already healthy at '+BASE); sys.exit(0)
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(ROOT/'server.log', 'ab') as log:
        os.chmod(ROOT/'server.log', 0o600)
        proc = subprocess.Popen([str(HOST),'serve','--http','--bind','127.0.0.1','--port',str(PORT),'--public-url',BASE],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    PID.write_text(str(proc.pid)+'\n'); PID.chmod(0o600)
    for _ in range(40):
        if healthy(): print('GBrain healthy at '+BASE); break
        if proc.poll() is not None: raise SystemExit('GBrain exited; inspect private runtime server.log')
        time.sleep(.25)
    else: raise SystemExit('GBrain did not become healthy')
elif action == 'stop':
    if not PID.exists(): raise SystemExit('No owned PID file; refusing to stop an untracked process')
    pid=int(PID.read_text());command=subprocess.run(['ps','-p',str(pid),'-o','command='],capture_output=True,text=True).stdout
    expected = str(pathlib.Path(CONFIG.get('source', pathlib.Path.home()/'.local/share/glance-qm/gbrain-source'))/'src/cli.ts')+' serve --http'
    if expected not in command: raise SystemExit('PID does not identify our GBrain server; refusing')
    os.kill(pid,signal.SIGTERM);PID.unlink();print('Stopped isolated GBrain server')
elif action == 'status':
    print(json.dumps({'healthy':healthy(),'mcpUrl':BASE+'/mcp','credentialFile':str(ROOT/'backend-oauth.json')}))
else: raise SystemExit('Usage: gbrain-service.py start|stop|status')
