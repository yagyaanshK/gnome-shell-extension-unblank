#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Run Unblank and optionally a local AOD reference in isolated GNOME sessions."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
UUID = 'unblank@sun.wxg@gmail.com'


def inside(source, reference, companion=None):
    home = Path(os.environ['HOME'])
    extensions = home / 'data/gnome-shell/extensions'
    metadata = json.loads((source / 'metadata.json').read_text())
    uuid = metadata['uuid']
    target = extensions / uuid
    shutil.copytree(source, target, ignore=shutil.ignore_patterns('gschemas.compiled', '__pycache__'))
    companion_uuid = None
    if companion:
        companion_uuid = json.loads((companion / 'metadata.json').read_text())['uuid']
        dest = extensions / companion_uuid
        shutil.copytree(companion, dest, ignore=shutil.ignore_patterns('gschemas.compiled', '__pycache__'))
        if (dest / 'schemas').exists():
            subprocess.run(['glib-compile-schemas', '--strict', str(dest / 'schemas')], check=True)
    subprocess.run(['glib-compile-schemas', '--strict', str(target / 'schemas')], check=True)
    settings = ['gsettings', '--schemadir', str(target / 'schemas'), 'set', metadata['settings-schema']]
    values = ({'software-dimming': 'true', 'brightness-reduction': '40', 'fade-in-time': '1500',
               'fade-out-time': '300', 'idle-delay': '10', 'disable-on-battery': 'true', 'aod-timeout': '0'}
              if reference else {'aod-mode': 'true', 'aod-software-dimming': 'true', 'aod-brightness': '40',
                  'aod-fade-in': '1500', 'aod-fade-out': '300', 'aod-idle-delay': '10', 'power': 'true', 'time': '0'})
    values.update({'oled-shift': 'true', 'oled-shift-radius': '12', 'oled-shift-interval': '60'})
    for key, value in values.items():
        subprocess.run(settings + [key, value], check=True, stdout=subprocess.DEVNULL)
    test = extensions / 'unblank-test@test.invalid'
    test.mkdir()
    (test / 'metadata.json').write_text(json.dumps({'uuid': test.name, 'name': 'Unblank isolated test',
        'description': 'Disposable integration test', 'shell-version': ['50'], 'session-modes': ['user', 'unlock-dialog']}))
    result = home / 'result.json'
    script = (ROOT / 'tests/aod-session.js').read_text().replace('TEST_UUID', json.dumps(uuid))
    script = script.replace('IS_REFERENCE', str(reference).lower()).replace('RESULT_FILE', json.dumps(str(result)))
    (test / 'extension.js').write_text(script)
    enabled = ([companion_uuid] if companion_uuid else []) + [uuid, test.name]
    subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(enabled)], check=True)
    with (home / 'shell.log').open('w') as log:
        shell = subprocess.Popen(['gnome-shell', '--headless', '--wayland', '--no-x11',
            '--virtual-monitor=1280x720', '--mode=user'], stdout=log, stderr=log,
            env=dict(os.environ, GNOME_SHELL_SESSION_MODE='user', LIBGL_ALWAYS_SOFTWARE='1'))
        try:
            for _ in range(500):
                if result.exists():
                    data = json.loads(result.read_text())
                    print(json.dumps(data), flush=True)
                    if not data['ok']:
                        print((home / 'shell.log').read_text()[-10000:], file=sys.stderr)
                        raise SystemExit(1)
                    return
                if shell.poll() is not None:
                    break
                time.sleep(.1)
            print((home / 'shell.log').read_text()[-12000:], file=sys.stderr)
            raise SystemExit('Headless test timed out')
        finally:
            shell.terminate()
            try:
                shell.wait(timeout=5)
            except subprocess.TimeoutExpired:
                shell.kill()
                shell.wait()


def run(source, reference, companion=None):
    with tempfile.TemporaryDirectory(prefix='unblank-test-', dir='/tmp', ignore_cleanup_errors=True) as tmp:
        env = dict(os.environ, HOME=tmp, XDG_CONFIG_HOME=tmp + '/config', XDG_CACHE_HOME=tmp + '/cache',
            XDG_DATA_HOME=tmp + '/data', XDG_RUNTIME_DIR=tmp + '/runtime', GIO_USE_VFS='local')
        for key in ['DCONF_PROFILE', 'GSETTINGS_BACKEND', 'WAYLAND_DISPLAY', 'DISPLAY']:
            env.pop(key, None)
        Path(env['XDG_RUNTIME_DIR']).mkdir(mode=0o700)
        args = ['dbus-run-session', '--', sys.executable, __file__, '--inside', '--source', str(source)]
        if reference:
            args.append('--reference')
        if companion:
            args.extend(['--companion', str(companion)])
        try:
            result = subprocess.run(args, env=env, capture_output=True, text=True)
            print(result.stdout, end='', flush=True)
            if result.returncode:
                print(result.stderr[-14000:], file=sys.stderr)
                raise SystemExit(result.returncode)
        finally:
            subprocess.run(['fusermount3', '-u', '-z', tmp + '/runtime/doc'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inside', action='store_true')
    parser.add_argument('--reference', action='store_true')
    parser.add_argument('--source', type=Path, default=ROOT / UUID)
    parser.add_argument('--companion', type=Path, help='Optional additional UI extension, e.g. an analog lock clock')
    args = parser.parse_args()
    if args.inside:
        inside(args.source, args.reference, args.companion)
    else:
        run(args.source, args.reference, args.companion)
