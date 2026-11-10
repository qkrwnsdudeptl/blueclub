"""Run isolated UI checks: python tests/check_interface_copy.py (requires Playwright)."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app

with tempfile.TemporaryDirectory(prefix='erp-copy-') as directory:
    root = Path(directory)
    app.DB_PATH = root / 'inventory.db'
    app.BUSINESS_DATA_DIR = root / 'business'
    app.BACKUP_DIR = root / 'backup'
    app.COPY_PATH = root / 'copy.json'
    app.CATALOG_PATH = root / 'catalog.json'
    app.NOTICE_PATH = root / 'notice.json'
    os.environ['ERP_ADMIN_CODE'] = 'test-only-code'
    for business in app.BUSINESS_MAP:
        with app.business_scope(business):
            app.init_db()
    class QuietHandler(app.Handler):
        def log_message(self, *_):
            pass
    server = app.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        result = subprocess.run(['node', str(Path(__file__).with_suffix('.cjs'))], env=dict(os.environ, TEST_URL=f'http://127.0.0.1:{server.server_port}'), timeout=120)
        sys.exit(result.returncode)
    finally:
        server.shutdown()
