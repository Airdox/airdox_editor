#!/usr/bin/env python3
"""Pinned official Colab CLI: prepare/probe until OAuth consent, or local login.

Linux/macOS only (WSL is Linux). Never allocates a runtime. The default probe
uses a fresh credential-free HOME and closed stdin. Personal login is a separate
explicit command run by the user in their own terminal, never via chat/CI.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import venv

VERSION = '0.7.4'
WHEEL = f'google_colab_cli-{VERSION}-py3-none-any.whl'
WHEEL_SHA256 = '1435f3533a7064f27b8b81252da85370427d6cf93b94e6c34737bd1cc68ec292'
REDIRECT = 'https://sdk.cloud.google.com/applicationdefaultauthcode.html'


def probe(cli, environment):
    """Invoke the real CLI; discard OAuth state/URL, keep only public flow metadata."""
    with tempfile.TemporaryDirectory(prefix='airdox-oauth-probe-') as temporary:
        env = dict(environment, HOME=temporary, XDG_CONFIG_HOME=str(Path(temporary) / '.config'),
                   NO_COLOR='1', COLUMNS='10000')
        env.pop('GOOGLE_APPLICATION_CREDENTIALS', None)
        result = subprocess.run([str(cli), '--auth=oauth2', '--client-oauth-config', str(Path(temporary) / 'absent.json'), 'whoami'],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding='utf-8', errors='replace', env=env, timeout=60)
        output = result.stdout + '\n' + result.stderr
        candidates = re.findall(r'https://accounts\.google\.com/[^\s\x1b]+', output)
        for candidate in candidates:
            parsed = urllib.parse.urlparse(candidate)
            query = urllib.parse.parse_qs(parsed.query)
            if (parsed.scheme == 'https' and parsed.hostname == 'accounts.google.com'
                    and query.get('redirect_uri') == [REDIRECT]
                    and query.get('response_type') == ['code']
                    and query.get('token_usage') == ['remote']
                    and query.get('state') and query.get('client_id')
                    and 'Enter the authorization code:' in output and result.returncode != 0):
                if list(Path(temporary).rglob('token.json')):
                    raise RuntimeError('Unexpected credentials in fresh probe HOME')
                return dict(result='PASS', state='AUTH_REQUIRED', authenticated=False,
                            googleConsent='NOT_GRANTED', runtimeProvisioned=False, driveAuthorized=False,
                            provider='oauth2', authorizationHost=parsed.hostname, redirectUri=REDIRECT,
                            scopes=query.get('scope', [''])[0].split(), cliExitCode=result.returncode,
                            boundary='Actual official CLI requested an authorization code; stdin intentionally closed',
                            oauthStatePersisted=False, tokenFileCreated=False)
        # Do not echo the raw OAuth URL, state, code, or traceback into evidence.
        raise RuntimeError(f'Official CLI did not reach the expected OAuth boundary (exit {result.returncode}); no successful authorization claimed')


def environment_paths(directory):
    base = Path(directory).expanduser().resolve()
    return base, base / 'runtime/bin/python', base / 'runtime/bin/colab'


def prepare(directory):
    if sys.platform not in ('linux', 'darwin') or sys.version_info < (3, 12):
        raise RuntimeError('Official CLI requires Linux/macOS (or WSL) and Python >=3.12. No native Windows support is claimed.')
    base, python, cli = environment_paths(directory)
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not python.is_file():
        venv.EnvBuilder(with_pip=True).create(base / 'runtime')
    with tempfile.TemporaryDirectory(prefix='airdox-colab-cli-wheel-') as temporary:
        with urllib.request.urlopen(f'https://pypi.org/pypi/google-colab-cli/{VERSION}/json', timeout=30) as response:
            metadata = json.load(response)
        item = next(x for x in metadata['urls'] if x['filename'] == WHEEL)
        url = urllib.parse.urlparse(item['url'])
        if url.scheme != 'https' or url.hostname != 'files.pythonhosted.org' or item['digests']['sha256'] != WHEEL_SHA256:
            raise RuntimeError('Unexpected pinned CLI download metadata')
        with urllib.request.urlopen(item['url'], timeout=60) as response:
            data = response.read(16 * 1024 * 1024)
        if hashlib.sha256(data).hexdigest() != WHEEL_SHA256:
            raise RuntimeError('CLI wheel hash mismatch')
        wheel = Path(temporary) / WHEEL
        wheel.write_bytes(data)
        subprocess.run([str(python), '-m', 'pip', '--isolated', 'install', '--no-input', '--index-url', 'https://pypi.org/simple', str(wheel)], check=True)
    subprocess.run([str(python), '-m', 'pip', 'check'], check=True)
    return base, python, cli


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('command', choices=['prepare', 'login'])
    parser.add_argument('--directory', default=f'~/.local/share/airdox/colab-cli-{VERSION}')
    parser.add_argument('--report', default='airdox-cli-auth-boundary.json')
    parser.add_argument('--consent', action='store_true', help='Explicitly start personal OAuth in this terminal; never use in CI/chat')
    parser.add_argument('--source-commit', default=None)
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == 'login':
        if not args.consent or not sys.stdin.isatty() or os.environ.get('GITHUB_ACTIONS'):
            raise RuntimeError('Login requires --consent in your own interactive terminal. Never paste credentials into chat/CI.')
        if sys.platform not in ('linux', 'darwin'):
            raise RuntimeError('Use Linux/macOS or WSL, not native Windows.')
        base, _, cli = environment_paths(args.directory)
        if not cli.is_file():
            raise RuntimeError('Run prepare first')
        private_home = base / 'credentials-home'
        private_home.mkdir(mode=0o700, exist_ok=True)
        private_home.chmod(0o700)
        print('Personal OAuth: review the scopes at Google. Paste the code ONLY into this local terminal. No runtime is allocated.', flush=True)
        # No transcript capture: personal identity/token output must never enter release evidence.
        result = subprocess.run([str(cli), '--auth=oauth2', 'whoami'],
                                env=dict(os.environ, HOME=str(private_home), XDG_CONFIG_HOME=str(private_home / '.config')))
        return result.returncode
    base, python, cli = prepare(args.directory)
    report = probe(cli, os.environ)
    report.update(schemaVersion=1, sourceCommit=args.source_commit, testedAt=datetime.now(timezone.utc).isoformat(),
                  cliVersion=VERSION, cliWheelSha256=WHEEL_SHA256, platform=platform.system(),
                  python=platform.python_version(),
                  installedPackages=subprocess.check_output([str(python), '-m', 'pip', 'freeze'], text=True).splitlines(),
                  scope='Official CLI locally installed and reached OAuth prompt; Google server acceptance/account access NOT tested')
    target = Path(args.report)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: report[key] for key in ('result', 'state', 'authenticated', 'cliVersion', 'runtimeProvisioned')}, indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(f'PREPARATION_FAILED: {type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
