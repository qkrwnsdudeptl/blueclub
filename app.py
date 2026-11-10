from __future__ import annotations

import base64
from calendar import monthrange
import io
import json
import os
import re
import secrets
import time
import socket
import sys
import threading
from contextvars import ContextVar
from contextlib import closing, contextmanager
from http.cookies import SimpleCookie
import sqlite3
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from production import SOURCE_PREFIX, list_production, record_production, save_recipe


ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "inventory.db"
STATIC = ROOT / "static"
BACKUP_DIR = ROOT / "backups"
BUSINESS_DATA_DIR = ROOT / "business_data"
BUSINESSES = [
    {"id": "delivery", "name": "내일배송", "theme": "teal"},
    {"id": "cafe", "name": "카페온리", "theme": "coffee"},
    {"id": "raon", "name": "공동작업장 라온", "theme": "blue"},
    {"id": "flower", "name": "다시 봄 화원", "theme": "rose"},
    {"id": "kitchen", "name": "엄마손밥상", "theme": "amber"},
    {"id": "dumpling", "name": "엄마손만두", "theme": "plum"},
]
CATALOG_PATH = ROOT / "business_catalog.json"
HOME_WIDGETS = ("items", "purchase", "sale", "amount", "stock", "recent")
THEMES = ("teal", "coffee", "blue", "rose", "amber", "plum", "ink", "clear", "salt", "gothic", "stone")
BUSINESS_MAP = {
    b["id"]: {**b, "widgets": dict.fromkeys(HOME_WIDGETS, True), "archived": False,
              "production_enabled": b["id"] == "raon"} for b in BUSINESSES
}
WELCOME_DEFAULTS = {
    "title": "erp비스무리에 오신 것을 환영합니다",
    "message": "접속할 사업단을 선택해 주세요.",
}
ACTIVE_BUSINESS = ContextVar("active_business", default="delivery")
REQUEST_LOCK = threading.RLock()
ADMIN_SESSIONS = {}
LOGIN_FAILURES = {}
ADMIN_CODE_PATH = ROOT / "admin.local"
NOTICE_PATH = ROOT / "active_notice.json"
NOTICE_CHANGED = threading.Condition()
persistent_notices = []
temporary_notice = None
notice_revision = 0


def load_notices():
    global persistent_notices
    if not NOTICE_PATH.exists():
        return
    saved = json.loads(NOTICE_PATH.read_text(encoding="utf-8"))
    if isinstance(saved, list):
        persistent_notices = saved
    elif isinstance(saved, dict) and saved.get("mode") == "persistent":
        persistent_notices = [{**saved, "enabled": True}]


def save_persistent_notices(notices):
    global persistent_notices, notice_revision
    temporary = NOTICE_PATH.with_suffix(".tmp")
    temporary.write_bytes(json_bytes(notices))
    temporary.replace(NOTICE_PATH)
    with NOTICE_CHANGED:
        persistent_notices = notices
        notice_revision += 1
        NOTICE_CHANGED.notify_all()


def set_temporary_notice(notice):
    global temporary_notice, notice_revision
    with NOTICE_CHANGED:
        temporary_notice = notice
        notice_revision += 1
        NOTICE_CHANGED.notify_all()


def active_businesses():
    return [business for business in BUSINESS_MAP.values() if not business["archived"]]


def load_business_catalog():
    if CATALOG_PATH.exists():
        saved = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
        BUSINESS_MAP.update(
            (business["id"], {"production_enabled": business["id"] == "raon", **business})
            for business in saved
        )


def save_business(business):
    updated = {**BUSINESS_MAP, business["id"]: business}
    temporary = CATALOG_PATH.with_suffix(".tmp")
    temporary.write_bytes(json_bytes(list(updated.values())))
    temporary.replace(CATALOG_PATH)
    BUSINESS_MAP.update(updated)


def business_template(payload):
    name = payload.get("name")
    theme = payload.get("theme")
    widgets = payload.get("widgets")
    production_enabled = payload.get("production_enabled", False)
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 50:
        raise ValueError("사업단 이름을 1~50자로 입력해 주세요.")
    if theme not in THEMES:
        raise ValueError("대표 색상을 선택해 주세요.")
    if not isinstance(widgets, dict) or any(type(widgets.get(key)) is not bool for key in HOME_WIDGETS):
        raise ValueError("홈 항목 설정이 올바르지 않습니다.")
    if type(production_enabled) is not bool:
        raise ValueError("생산 기능 사용 여부를 확인해 주세요.")
    return {"name": name.strip(), "theme": theme, "widgets": {key: widgets[key] for key in HOME_WIDGETS},
            "production_enabled": production_enabled}


@contextmanager
def business_scope(business_id):
    if business_id not in BUSINESS_MAP:
        raise ValueError("등록되지 않은 사업단입니다.")
    token = ACTIVE_BUSINESS.set(business_id)
    try:
        yield
    finally:
        ACTIVE_BUSINESS.reset(token)


def business_db_path():
    business_id = ACTIVE_BUSINESS.get()
    return DB_PATH if business_id == "delivery" else BUSINESS_DATA_DIR / f"{business_id}.db"


def connect_db() -> sqlite3.Connection:
    db = sqlite3.connect(business_db_path())
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


@contextmanager
def database():
    with closing(connect_db()) as db, db:
        yield db


def init_db() -> None:
    business_db_path().parent.mkdir(parents=True, exist_ok=True)
    with database() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                unit TEXT NOT NULL DEFAULT '개',
                unit_price INTEGER NOT NULL DEFAULT 0,
                tax_type TEXT NOT NULL DEFAULT '면세',
                min_stock INTEGER NOT NULL DEFAULT 0,
                item_type TEXT NOT NULL DEFAULT 'STOCK' CHECK(item_type IN ('STOCK','SERVICE')),
                active INTEGER NOT NULL DEFAULT 1,
                archived_at TEXT,
                import_key TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS partners (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL DEFAULT '기관',
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                transaction_date TEXT NOT NULL,
                transaction_type TEXT NOT NULL CHECK(transaction_type IN ('PURCHASE','SALE','ISSUE','RETURN_IN','RETURN_OUT','ADJUST_IN','ADJUST_OUT')),
                item_id INTEGER NOT NULL REFERENCES items(id),
                partner_id INTEGER REFERENCES partners(id),
                quantity INTEGER NOT NULL CHECK(quantity > 0),
                unit_price INTEGER NOT NULL DEFAULT 0,
                note TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT 'manual',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date);
            CREATE INDEX IF NOT EXISTS idx_transactions_item ON transactions(item_id);
            CREATE TABLE IF NOT EXISTS daily_reports (
                report_date TEXT PRIMARY KEY,
                manager TEXT NOT NULL DEFAULT '',
                team_lead TEXT NOT NULL DEFAULT '',
                section_chief TEXT NOT NULL DEFAULT '',
                director TEXT NOT NULL DEFAULT '',
                work_time TEXT NOT NULL DEFAULT '',
                workers TEXT NOT NULL DEFAULT '',
                common_tasks TEXT NOT NULL DEFAULT '',
                work_notes TEXT NOT NULL DEFAULT '',
                digital_lock TEXT NOT NULL DEFAULT '무',
                warehouse_door TEXT NOT NULL DEFAULT '무',
                activity_content TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT 'manual',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS daily_item_notes (
                report_date TEXT NOT NULL,
                item_id INTEGER NOT NULL REFERENCES items(id),
                note TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT 'excel',
                PRIMARY KEY(report_date, item_id)
            );
            CREATE TABLE IF NOT EXISTS stock_snapshots (
                report_date TEXT NOT NULL,
                item_id INTEGER NOT NULL REFERENCES items(id),
                quantity INTEGER NOT NULL,
                source TEXT NOT NULL DEFAULT 'manual',
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(report_date, item_id, source)
            );
            CREATE INDEX IF NOT EXISTS idx_stock_snapshots_date ON stock_snapshots(report_date);
            CREATE TABLE IF NOT EXISTS production_components (
                finished_id INTEGER NOT NULL REFERENCES items(id),
                item_id INTEGER NOT NULL REFERENCES items(id),
                quantity INTEGER NOT NULL CHECK(quantity > 0),
                package_id INTEGER REFERENCES items(id),
                package_size INTEGER,
                PRIMARY KEY(finished_id, item_id),
                CHECK(finished_id <> item_id),
                CHECK((package_id IS NULL AND package_size IS NULL) OR
                      (package_id IS NOT NULL AND package_size IS NOT NULL AND package_size > 0
                       AND package_id <> item_id AND package_id <> finished_id))
            );
            CREATE TABLE IF NOT EXISTS production_batches (
                id TEXT PRIMARY KEY,
                produced_date TEXT NOT NULL,
                finished_id INTEGER NOT NULL REFERENCES items(id),
                quantity INTEGER NOT NULL CHECK(quantity > 0),
                details TEXT NOT NULL CHECK(json_valid(details)),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        columns = {r["name"] for r in db.execute("PRAGMA table_info(transactions)").fetchall()}
        if "source" not in columns:
            db.execute("ALTER TABLE transactions ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
        report_columns = {r["name"] for r in db.execute("PRAGMA table_info(daily_reports)").fetchall()}
        if "source" not in report_columns:
            db.execute("ALTER TABLE daily_reports ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
        item_columns = {r["name"] for r in db.execute("PRAGMA table_info(items)").fetchall()}
        if "item_type" not in item_columns:
            db.execute("ALTER TABLE items ADD COLUMN item_type TEXT NOT NULL DEFAULT 'STOCK'")
        if "archived_at" not in item_columns:
            db.execute("ALTER TABLE items ADD COLUMN archived_at TEXT")
        if "import_key" not in item_columns:
            db.execute("ALTER TABLE items ADD COLUMN import_key TEXT")
        if ACTIVE_BUSINESS.get() == "delivery":
            db.execute("CREATE TABLE IF NOT EXISTS welcome_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute(
                "UPDATE welcome_settings SET value = replace(value, ?, ?) WHERE instr(value, ?) > 0",
                ("오늘재고", "erp비스무리", "오늘재고"),
            )


def get_welcome_settings():
    with business_scope("delivery"), database() as db:
        saved = dict(db.execute("SELECT key, value FROM welcome_settings").fetchall())
    return {key: saved.get(key, default) for key, default in WELCOME_DEFAULTS.items()}


def create_backup(label="auto") -> Path:
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    output = BACKUP_DIR / f"inventory_{ACTIVE_BUSINESS.get()}_{label}_{stamp}.db"
    with closing(connect_db()) as source, closing(sqlite3.connect(output)) as target:
        source.backup(target)
    return output


def create_daily_backup() -> None:
    BACKUP_DIR.mkdir(exist_ok=True)
    today_stamp = date.today().strftime("%Y%m%d")
    if not any(BACKUP_DIR.glob(f"inventory_{ACTIVE_BUSINESS.get()}_auto_{today_stamp}_*.db")):
        create_backup("auto")
    backups = sorted(BACKUP_DIR.glob(f"inventory_{ACTIVE_BUSINESS.get()}_auto_*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in backups[30:]:
        old.unlink(missing_ok=True)


BASE_DATA_TABLES = ("items", "partners", "transactions", "daily_reports", "daily_item_notes", "stock_snapshots")
DATA_TABLES = BASE_DATA_TABLES + ("production_components", "production_batches")
MAX_RESTORE_BYTES = 32 * 1024 * 1024


def backup_columns(db, table):
    return tuple(row[1] for row in db.execute(f"PRAGMA table_info({table})"))


def export_data(db, table_names=DATA_TABLES):
    return {
        "format": "erp-bismuri-business-v1",
        "tables": {table: [dict(row) for row in db.execute(f"SELECT * FROM {table}")] for table in table_names},
    }


def restore_data(db, raw, file_format):
    try:
        if file_format == "sqlite":
            if not raw.startswith(b"SQLite format 3\0"):
                raise ValueError("SQLite 백업 파일을 선택해 주세요.")
            with closing(sqlite3.connect(":memory:")) as source:
                source.deserialize(raw)
                source.execute("PRAGMA trusted_schema=OFF")
                source.execute("PRAGMA query_only=ON")
                source.row_factory = sqlite3.Row
                actual = {row[1] for row in source.execute("PRAGMA table_list") if row[0] == "main" and row[2] == "table"}
                if not set(BASE_DATA_TABLES) <= actual or source.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise ValueError("이 앱에서 만든 정상적인 SQLite 백업이 필요합니다.")
                tables = export_data(source, [table for table in DATA_TABLES if table in actual])["tables"]
        else:
            data = json.loads(raw)
            if not isinstance(data, dict) or data.get("format") != "erp-bismuri-business-v1":
                raise ValueError("이 앱에서 내보낸 JSON 백업을 선택해 주세요.")
            tables = data.get("tables")
        if not isinstance(tables, dict) or not set(BASE_DATA_TABLES) <= set(tables) <= set(DATA_TABLES):
            raise ValueError("백업의 데이터 표 구성이 일치하지 않습니다.")
        tables = {table: tables.get(table, []) for table in DATA_TABLES}
        columns = {table: backup_columns(db, table) for table in DATA_TABLES}
        for table, rows in tables.items():
            if not isinstance(rows, list) or any(
                not isinstance(row, dict) or set(row) != set(columns[table])
                or any(type(value) not in (str, int, float, type(None)) for value in row.values())
                for row in rows
            ):
                raise ValueError(f"백업의 {table} 데이터 구조가 일치하지 않습니다.")
        backup = create_backup("before_restore")
        with db:
            for table in reversed(DATA_TABLES):
                db.execute(f"DELETE FROM {table}")
            for table in DATA_TABLES:
                cols = columns[table]
                params = ",".join("?" for _ in cols)
                db.executemany(
                    f"INSERT INTO {table} ({','.join(cols)}) VALUES ({params})",
                    ([row[col] for col in cols] for row in tables[table]),
                )
        return backup.name
    except (sqlite3.Error, UnicodeError, OverflowError) as exc:
        raise ValueError("백업 파일을 읽을 수 없거나 데이터 제약 조건에 맞지 않습니다.") from exc


def json_bytes(value) -> bytes:
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


def row_dict(row):
    return dict(row) if row else None


def current_stock(db: sqlite3.Connection, item_id: int) -> int:
    row = db.execute(
        """
        SELECT COALESCE(SUM(CASE WHEN transaction_type IN ('PURCHASE','RETURN_IN','ADJUST_IN') THEN quantity ELSE -quantity END), 0)
        FROM transactions WHERE item_id = ?
        """,
        (item_id,),
    ).fetchone()
    return int(row[0])


def get_items(db, include_inactive=False):
    where = "" if include_inactive else " WHERE active = 1"
    rows = db.execute(f"SELECT * FROM items{where} ORDER BY active DESC, id").fetchall()
    return [{**dict(r), "stock": current_stock(db, r["id"])} for r in rows]


def get_summary(db):
    today = date.today().isoformat()
    rows = db.execute(
        "SELECT transaction_type, COALESCE(SUM(quantity),0) qty, COALESCE(SUM(quantity*unit_price),0) amount FROM transactions WHERE transaction_date = ? GROUP BY transaction_type",
        (today,),
    ).fetchall()
    totals = {r["transaction_type"]: {"qty": r["qty"], "amount": r["amount"]} for r in rows}
    items = get_items(db)
    return {
        "today": today,
        "purchase_qty": totals.get("PURCHASE", {}).get("qty", 0),
        "sale_qty": totals.get("SALE", {}).get("qty", 0),
        "sale_amount": totals.get("SALE", {}).get("amount", 0),
        "issue_qty": totals.get("ISSUE", {}).get("qty", 0),
        "today_amount": sum(v["amount"] for v in totals.values()),
        "low_stock": [i for i in items if i.get("item_type", "STOCK") == "STOCK" and i["stock"] <= i["min_stock"]],
        "item_count": len(items),
    }


def get_daily_sheet(db, start: str, end: str, partner_id=None):
    """Sum the selected transactions while keeping inventory at the business level."""
    previous = (date.fromisoformat(end) - timedelta(days=1)).isoformat()
    before_start = (date.fromisoformat(start) - timedelta(days=1)).isoformat()
    movements = db.execute(
        """
        WITH ledger AS (
          SELECT *,
            CASE WHEN transaction_type IN ('PURCHASE','RETURN_IN','ADJUST_IN')
              THEN quantity ELSE -quantity END AS delta,
            transaction_date >= :start AND (:partner IS NULL OR partner_id = :partner) AS selected
          FROM transactions WHERE transaction_date <= :end
        )
        SELECT item_id,
          SUM(CASE WHEN transaction_date < :start THEN delta
                   WHEN transaction_date = :start AND transaction_type IN ('ADJUST_IN','ADJUST_OUT')
                     AND note = '엑셀 전일재고 자동 보정' THEN delta ELSE 0 END) AS opening,
          SUM(CASE WHEN transaction_date < :end THEN delta ELSE 0 END) AS previous,
          COUNT(CASE WHEN transaction_date < :end THEN 1 END) AS previous_entries,
          COUNT(CASE WHEN transaction_date <= :start THEN 1 END) AS opening_entries,
          SUM(delta) AS closing,
          SUM(CASE WHEN selected THEN 1 ELSE 0 END) AS matches,
          SUM(CASE WHEN selected AND transaction_type = 'PURCHASE' THEN quantity ELSE 0 END) AS purchases,
          SUM(CASE WHEN selected AND transaction_type IN ('RETURN_IN','ADJUST_IN')
                     AND source NOT LIKE 'production:%'
                     AND (transaction_type <> 'ADJUST_IN' OR note <> '엑셀 전일재고 자동 보정')
                   THEN quantity ELSE 0 END) AS other_in,
          SUM(CASE WHEN selected AND transaction_type IN ('RETURN_OUT','ADJUST_OUT')
                     AND source NOT LIKE 'production:%'
                     AND (transaction_type <> 'ADJUST_OUT' OR note <> '엑셀 전일재고 자동 보정')
                   THEN quantity ELSE 0 END) AS other_out,
          SUM(CASE WHEN selected AND transaction_type='ADJUST_IN' AND source LIKE 'production:%'
                   THEN quantity ELSE 0 END) AS production_in,
          SUM(CASE WHEN selected AND transaction_type='ADJUST_OUT' AND source LIKE 'production:%'
                   THEN quantity ELSE 0 END) AS production_out,
          SUM(CASE WHEN selected AND transaction_type IN ('SALE','ISSUE') THEN quantity ELSE 0 END) AS sales,
          SUM(CASE WHEN selected AND transaction_type = 'SALE' THEN quantity ELSE 0 END) AS service_sales,
          SUM(CASE WHEN selected AND transaction_type = 'SALE' THEN quantity * unit_price ELSE 0 END) AS amount,
          GROUP_CONCAT(CASE WHEN selected AND note <> '엑셀 전일재고 자동 보정' THEN NULLIF(note,'') END, ' / ') AS notes
        FROM ledger GROUP BY item_id
        """,
        {"start": start, "end": end, "partner": partner_id},
    ).fetchall()
    by_item = {row["item_id"]: row for row in movements}
    snapshots = {}
    for row in db.execute(
        """SELECT * FROM stock_snapshots WHERE report_date IN (?, ?, ?)
        ORDER BY created_at, source""",
        (before_start, previous, end),
    ):
        snapshots[row["item_id"], row["report_date"]] = row
    surveyed = {row[0] for row in db.execute("SELECT DISTINCT item_id FROM stock_snapshots")}
    notes = {} if partner_id is not None else {
        row["item_id"]: row["notes"] for row in db.execute(
            """SELECT item_id, GROUP_CONCAT(NULLIF(note,''), ' / ') AS notes FROM daily_item_notes
            WHERE report_date BETWEEN ? AND ? AND source='excel' GROUP BY item_id""",
            (start, end),
        )
    }
    rows = []
    for item in db.execute(
        """SELECT * FROM items WHERE active=1 OR archived_at IS NULL OR date(archived_at)>date(?)
        ORDER BY id""", (start,),
    ):
        item_id = item["id"]
        ledger = by_item.get(item_id)
        if partner_id is not None and (not ledger or not ledger["matches"]):
            continue
        service = item["item_type"] == "SERVICE"
        current_survey = snapshots.get((item_id, end))
        previous_survey = snapshots.get((item_id, previous))
        opening_survey = snapshots.get((item_id, before_start))
        unknown = service or (not ledger and item_id in surveyed)
        opening = None if unknown else (ledger["opening"] if ledger else 0)
        closing = None if unknown else (ledger["closing"] if ledger else 0)
        prior = None if unknown else (ledger["previous"] if ledger else 0)
        if not service and item_id in surveyed:
            if not ledger or not ledger["opening_entries"]:
                opening = opening_survey["quantity"] if opening_survey else None
            if not ledger or not ledger["previous_entries"]:
                prior = None
        if not service and current_survey:
            closing = current_survey["quantity"]
        if not service and previous_survey:
            prior = previous_survey["quantity"]
        note = notes.get(item_id) or (ledger["notes"] if ledger else "") or ""
        if partner_id is None and not service and current_survey:
            note = current_survey["note"] or note or "재고조사 자료"
        rows.append({
            "no": len(rows) + 1, "item_id": item_id, "item_name": item["name"],
            "unit": item["unit"], "unit_price": item["unit_price"], "tax_type": item["tax_type"],
            "item_type": item["item_type"], "opening_stock": opening, "closing_stock": closing,
            "stock_delta": closing - prior if closing is not None and prior is not None else None,
            "purchase_qty": ledger["purchases"] if ledger else 0,
            "other_in_qty": ledger["other_in"] if ledger and not service else None,
            "other_out_qty": ledger["other_out"] if ledger and not service else None,
            "production_in_qty": ledger["production_in"] if ledger and not service else None,
            "production_out_qty": ledger["production_out"] if ledger and not service else None,
            "sale_qty": ledger["service_sales" if service else "sales"] if ledger else 0,
            "sales_amount": ledger["amount"] if ledger else 0,
            "note": note,
        })
    return rows


def get_calendar_summary(db, month):
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        raise ValueError("조회 월을 확인해 주세요.")
    first = date.fromisoformat(month + "-01")
    last = first.replace(day=monthrange(first.year, first.month)[1])
    records = db.execute(
        """SELECT t.transaction_date, t.transaction_type, i.item_type, i.unit,
                  SUM(t.quantity) AS quantity, SUM(t.quantity * t.unit_price) AS amount, COUNT(*) AS entries
           FROM transactions t JOIN items i ON i.id=t.item_id
           WHERE t.transaction_date BETWEEN ? AND ?
           GROUP BY t.transaction_date, t.transaction_type, i.item_type, i.unit
           ORDER BY t.transaction_date, i.unit""",
        (first.isoformat(), last.isoformat()),
    )
    days, totals = {}, {"units": {}, "entries": 0, "sales_amount": 0}
    for record in records:
        day = days.setdefault(record["transaction_date"], {"units": {}, "entries": 0, "sales_amount": 0})
        for bucket in (day, totals):
            bucket["entries"] += record["entries"]
            kind = record["transaction_type"]
            if kind == "SALE":
                bucket["sales_amount"] += record["amount"]
            if record["item_type"] != "SERVICE":
                unit = bucket["units"].setdefault(record["unit"], {"in": 0, "out": 0})
                direction = "in" if kind in ("PURCHASE", "RETURN_IN", "ADJUST_IN") else "out"
                unit[direction] += record["quantity"]
    return {"month": month, "days": days, "totals": totals}


def get_monthly_summary(db: sqlite3.Connection, month: str):
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        raise ValueError("조회 월이 올바르지 않습니다.")
    year, month_no = map(int, month.split("-"))
    if month_no < 1 or month_no > 12:
        raise ValueError("조회 월이 올바르지 않습니다.")
    start = f"{year:04d}-{month_no:02d}-01"
    next_year, next_month = (year + 1, 1) if month_no == 12 else (year, month_no + 1)
    end = f"{next_year:04d}-{next_month:02d}-01"
    items = db.execute(
        """SELECT * FROM items i WHERE i.active=1 OR EXISTS(
        SELECT 1 FROM transactions t WHERE t.item_id=i.id AND t.transaction_date>=? AND t.transaction_date<?)
        ORDER BY i.id""",
        (start, end),
    ).fetchall()
    result = []
    for item in items:
        if item["item_type"] == "SERVICE":
            totals = db.execute("SELECT COALESCE(SUM(CASE WHEN transaction_type='PURCHASE' THEN quantity ELSE 0 END),0) purchase_qty, COALESCE(SUM(CASE WHEN transaction_type='SALE' THEN quantity ELSE 0 END),0) sale_qty, COALESCE(SUM(CASE WHEN transaction_type='ISSUE' THEN quantity ELSE 0 END),0) issue_qty, COALESCE(SUM(CASE WHEN transaction_type='PURCHASE' THEN quantity*unit_price ELSE 0 END),0) purchase_amount, COALESCE(SUM(CASE WHEN transaction_type='SALE' THEN quantity*unit_price ELSE 0 END),0) sales_amount FROM transactions WHERE item_id=? AND transaction_date>=? AND transaction_date<?", (item["id"], start, end)).fetchone()
            result.append({"item_id": item["id"], "item_name": item["name"], "unit": item["unit"], "item_type": "SERVICE", "opening_stock": None, "purchase_qty": int(totals["purchase_qty"]), "sale_qty": int(totals["sale_qty"]), "issue_qty": int(totals["issue_qty"]), "adjustment": 0, "closing_stock": None, "purchase_amount": int(totals["purchase_amount"]), "sales_amount": int(totals["sales_amount"]), "active": item["active"]})
            continue
        opening = db.execute(
            """SELECT COALESCE(SUM(CASE WHEN transaction_type IN ('PURCHASE','RETURN_IN','ADJUST_IN')
            THEN quantity ELSE -quantity END),0) FROM transactions
            WHERE item_id=? AND transaction_date<?""",
            (item["id"], start),
        ).fetchone()[0]
        totals = db.execute(
            """SELECT
            COALESCE(SUM(CASE WHEN transaction_type='PURCHASE' THEN quantity ELSE 0 END),0) purchase_qty,
            COALESCE(SUM(CASE WHEN transaction_type='SALE' THEN quantity ELSE 0 END),0) sale_qty,
            COALESCE(SUM(CASE WHEN transaction_type='ISSUE' THEN quantity ELSE 0 END),0) issue_qty,
            COALESCE(SUM(CASE WHEN transaction_type IN ('RETURN_IN','ADJUST_IN') THEN quantity ELSE 0 END),0) extra_in,
            COALESCE(SUM(CASE WHEN transaction_type IN ('RETURN_OUT','ADJUST_OUT') THEN quantity ELSE 0 END),0) extra_out,
            COALESCE(SUM(CASE WHEN transaction_type='PURCHASE' THEN quantity*unit_price ELSE 0 END),0) purchase_amount,
            COALESCE(SUM(CASE WHEN transaction_type='SALE' THEN quantity*unit_price ELSE 0 END),0) sales_amount
            FROM transactions WHERE item_id=? AND transaction_date>=? AND transaction_date<?""",
            (item["id"], start, end),
        ).fetchone()
        closing = int(opening) + int(totals["purchase_qty"]) + int(totals["extra_in"]) - int(totals["sale_qty"]) - int(totals["issue_qty"]) - int(totals["extra_out"])
        result.append({
            "item_id": item["id"], "item_name": item["name"], "unit": item["unit"],
            "opening_stock": int(opening), "purchase_qty": int(totals["purchase_qty"]),
            "sale_qty": int(totals["sale_qty"]), "issue_qty": int(totals["issue_qty"]),
            "adjustment": int(totals["extra_in"]) - int(totals["extra_out"]),
            "closing_stock": closing, "purchase_amount": int(totals["purchase_amount"]),
            "sales_amount": int(totals["sales_amount"]), "active": item["active"],
        })
    return {"month": month, "rows": result}


def get_daily_report(db, target_date: str):
    row = db.execute("SELECT * FROM daily_reports WHERE report_date = ?", (target_date,)).fetchone()
    if row:
        return dict(row)
    return {
        "report_date": target_date,
        "manager": "", "team_lead": "", "section_chief": "", "director": "",
        "work_time": "", "workers": "", "common_tasks": "", "work_notes": "",
        "digital_lock": "무", "warehouse_door": "무", "activity_content": "",
    }


XLSX_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main", "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}


def _xlsx_cell_value(cell, shared_strings):
    value = cell.find("m:v", XLSX_NS)
    if value is None:
        inline = cell.find("m:is", XLSX_NS)
        if inline is not None:
            return "".join(t.text or "" for t in inline.iter("{%s}t" % XLSX_NS["m"]))
        return ""
    raw = value.text or ""
    if cell.attrib.get("t") == "s" and raw:
        try:
            return shared_strings[int(raw)]
        except (ValueError, IndexError):
            return raw
    return raw


def _parse_stock_snapshot_workbook(sheets, shared_strings, filename=""):
    """Best-effort parser for stock-count sheets without opening/closing stock."""
    aliases = {
        "item": ("품명", "품목명", "상품명", "제품명", "식품명", "재료명", "품목"),
        "quantity": ("현재고", "현재수량", "재고수량", "재고", "수량", "잔량"),
        "unit": ("단위", "규격"),
        "price": ("단가", "가격", "매입가"),
        "note": ("비고", "메모", "특이사항"),
    }
    def normalize(value):
        return re.sub(r"[\s·ㆍ()（）\[\]{}:_\-/]", "", str(value or "")).lower()
    def extract_date(text):
        match = re.search(r"(20\d{2})[.\-/년 ]+([01]?\d)[.\-/월 ]+([0-3]?\d)", text or "")
        if match:
            try: return date(int(match.group(1)), int(match.group(2)), int(match.group(3))).isoformat()
            except ValueError: return None
        match = re.search(r"(?<!\d)(\d{6})(?!\d)", text or "")
        if match:
            try: return date(2000 + int(match.group(1)[:2]), int(match.group(1)[2:4]), int(match.group(1)[4:])).isoformat()
            except ValueError: return None
        return None
    result = []
    for sheet_name, root in sheets:
        rows = []
        for row in root.findall(".//m:sheetData/m:row", XLSX_NS):
            values = {}
            for cell in row.findall("m:c", XLSX_NS):
                ref = cell.attrib.get("r", "")
                col = re.match(r"[A-Z]+", ref)
                if col: values[col.group(0)] = _xlsx_cell_value(cell, shared_strings).strip()
            if values: rows.append((int(row.attrib.get("r", "0")), values))
        header = None
        columns = {}
        for row_no, values in rows[:40]:
            normalized = {col: normalize(value) for col, value in values.items()}
            found = {}
            for key, words in aliases.items():
                for col, value in normalized.items():
                    if any(normalize(word) in value for word in words):
                        found[key] = col; break
            if "item" in found and "quantity" in found:
                header, columns = row_no, found; break
        if not header:
            continue
        target_date = extract_date(" ".join([filename, sheet_name] + [" ".join(v.values()) for _, v in rows[:8]]))
        if not target_date:
            continue
        for row_no, values in rows:
            if row_no <= header: continue
            name = str(values.get(columns["item"], "")).strip()
            if not name or name in ("합계", "총계", "소계", "합") or re.fullmatch(r"[0-9.,]+", name): continue
            raw_qty = str(values.get(columns["quantity"], "")).replace(",", "").strip()
            if not raw_qty: continue
            try: quantity = int(float(raw_qty))
            except ValueError: continue
            if quantity < 0: continue
            unit = str(values.get(columns.get("unit", ""), "개")).strip() or "개"
            raw_price = str(values.get(columns.get("price", ""), "0")).replace(",", "").strip()
            try: price = int(float(raw_price)) if raw_price else 0
            except ValueError: price = 0
            note = str(values.get(columns.get("note", ""), "")).strip()
            result.append({"date": target_date, "item_name": name, "unit": unit, "unit_price": price, "tax_type": "면세", "opening_stock": None, "purchase_qty": 0, "sale_qty": 0, "closing_stock": quantity, "sales_amount": 0, "note": note, "source_sheet": sheet_name, "source_row": row_no, "mode": "snapshot"})
    return result


def parse_inventory_workbook(encoded: str, include_reports=False, filename=""):
    """Validate and parse the supplied operating-log workbook."""
    try:
        raw = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise ValueError("엑셀 파일 데이터가 올바르지 않습니다.") from exc
    if len(raw) > 20 * 1024 * 1024:
        raise ValueError("20MB 이하의 .xlsx 파일만 올릴 수 있습니다.")
    if not raw.startswith(b"PK"):
        raise ValueError("현재는 .xlsx 파일을 지원합니다. 구형 .xls는 .xlsx로 저장한 뒤 올려주세요.")
    shared, sheets = [], []
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            if archive.testzip():
                raise ValueError("엑셀 파일 내부가 손상되었습니다.")
            required = {"xl/workbook.xml", "xl/_rels/workbook.xml.rels"}
            if not required.issubset(archive.namelist()):
                raise ValueError("엑셀 통합문서 구조를 읽을 수 없습니다.")
            if "xl/sharedStrings.xml" in archive.namelist():
                root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
                shared = ["".join(t.text or "" for t in si.iter("{%s}t" % XLSX_NS["m"])) for si in root.findall("m:si", XLSX_NS)]
            workbook = ET.fromstring(archive.read("xl/workbook.xml"))
            rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
            rel_map = {x.attrib["Id"]: x.attrib["Target"] for x in rels}
            for sheet in workbook.find("m:sheets", XLSX_NS):
                name = sheet.attrib.get("name", "")
                rid = sheet.attrib.get("{%s}id" % XLSX_NS["r"])
                target = rel_map.get(rid, "")
                if not target.startswith("xl/"):
                    target = "xl/" + target
                if target in archive.namelist():
                    sheets.append((name, ET.fromstring(archive.read(target))))
    except (zipfile.BadZipFile, ET.ParseError) as exc:
        raise ValueError("엑셀 파일이 손상되어 읽을 수 없습니다.") from exc

    result, reports, errors, warnings, seen_dates = [], [], [], [], set()
    for sheet_name, root in sheets:
        # Daily sheets are named like 0731(금). Monthly stock summary tabs are skipped.
        match = re.match(r"^(\d{2})(\d{2})\(", sheet_name)
        if not match:
            continue
        cell_map = {}
        for cell in root.findall(".//m:sheetData/m:row/m:c", XLSX_NS):
            cell_map[cell.attrib.get("r", "")] = _xlsx_cell_value(cell, shared)
        def text_at(ref):
            return str(cell_map.get(ref, "")).strip()
        title = text_at("A1")
        date_match = re.search(r"(20\d{2})\.\s*(\d{1,2})\.\s*(\d{1,2})", title)
        if not date_match:
            errors.append(f"{sheet_name}: 제목에서 연도를 찾을 수 없습니다.")
            continue
        year, tab_month, tab_day = int(date_match.group(1)), int(match.group(1)), int(match.group(2))
        try:
            target_date = date(year, tab_month, tab_day).isoformat()
        except ValueError:
            errors.append(f"{sheet_name}: 시트 탭의 날짜가 올바르지 않습니다.")
            continue
        title_date = f"{year:04d}-{int(date_match.group(2)):02d}-{int(date_match.group(3)):02d}"
        if title_date != target_date:
            warnings.append(f"{sheet_name}: 제목 날짜 {title_date} 대신 시트 탭 날짜 {target_date}을 적용했습니다.")
        if target_date in seen_dates:
            errors.append(f"{sheet_name}: 같은 날짜의 시트가 중복되었습니다.")
            continue
        seen_dates.add(target_date)
        normalize = lambda value: re.sub(r"[\s·ㆍ]", "", str(value))
        expected_headers = {"B17":"품명", "C17":"단위", "D17":"단가", "E17":"면과세", "F17":"전일재고", "G17":"매입", "I17":"매출", "J17":"금일재고", "K17":"판매금액", "L17":"비고"}
        for ref, expected in expected_headers.items():
            if expected not in normalize(text_at(ref)):
                errors.append(f"{sheet_name}: {ref} 열 제목이 예상 양식과 다릅니다.")
        reports.append({
            "report_date": target_date,
            "manager": text_at("I2"), "team_lead": text_at("J2"), "section_chief": text_at("K2"), "director": text_at("L2"),
            "work_time": "\n".join(x for x in [text_at("A7"), text_at("A9")] if x),
            "workers": "\n".join(x for x in [text_at("E7"), text_at("E9")] if x),
            "common_tasks": text_at("H7"), "work_notes": text_at("K7"),
            "digital_lock": text_at("E14") or "무", "warehouse_door": text_at("E15") or "무",
            "activity_content": text_at("H13"),
        })
        for row in root.findall(".//m:sheetData/m:row", XLSX_NS):
            row_no = int(row.attrib.get("r", 0))
            if row_no < 18 or row_no > 68:
                continue
            values = {}
            for cell in row.findall("m:c", XLSX_NS):
                ref = cell.attrib.get("r", "")
                col = re.match(r"[A-Z]+", ref)
                if col:
                    values[col.group(0)] = _xlsx_cell_value(cell, shared)
            name = str(values.get("B", "")).strip()
            sequence = str(values.get("A", "")).strip()
            if not name or not re.fullmatch(r"\d+(?:\.0+)?", sequence):
                continue
            def number(key):
                text = str(values.get(key, "")).replace(",", "").strip()
                try:
                    return int(float(text)) if text else 0
                except ValueError:
                    errors.append(f"{sheet_name} {key}{row_no}: 숫자 값이 올바르지 않습니다.")
                    return 0
            unit = str(values.get("C", "")).strip()
            tax_type = str(values.get("E", "")).strip()
            unit_price, opening, purchase, sale = number("D"), number("F"), number("G"), number("I")
            closing, sales_amount = number("J"), number("K")
            if tax_type not in ("면세", "과세"):
                errors.append(f"{sheet_name} {row_no}행: 과세구분이 올바르지 않습니다.")
            if min(unit_price, opening, purchase, sale, closing, sales_amount) < 0:
                errors.append(f"{sheet_name} {row_no}행: 음수 값은 가져올 수 없습니다.")
            if closing != opening + purchase - sale:
                errors.append(f"{sheet_name} {row_no}행: 금일재고 계산이 맞지 않습니다.")
            if sales_amount != unit_price * sale:
                errors.append(f"{sheet_name} {row_no}행: 판매금액 계산이 맞지 않습니다.")
            row_data = {
                "date": target_date,
                "item_name": name, "unit": unit, "unit_price": unit_price, "tax_type": tax_type,
                "opening_stock": opening, "purchase_qty": purchase, "sale_qty": sale,
                "closing_stock": closing, "sales_amount": sales_amount,
                "note": str(values.get("L", "")).strip(),
                "source_sheet": sheet_name, "source_row": row_no,
            }
            result.append(row_data)
    units_by_name = {}
    for row in result:
        if row["unit"]:
            units_by_name.setdefault(row["item_name"], set()).add(row["unit"])
    inferred_names = set()
    for row in result:
        units = units_by_name.get(row["item_name"], set())
        if len(units) > 1:
            errors.append(f"{row['item_name']}: 시트마다 단위가 다릅니다.")
        if not row["unit"]:
            row["unit"] = next(iter(units)) if len(units) == 1 else "개"
            inferred_names.add(row["item_name"])
    for name in inferred_names:
        warnings.append(f"{name}: 비어 있는 단위를 다른 날짜의 값으로 자동 보완했습니다.")
    combined = {}
    duplicate_groups = set()
    for row in result:
        key = (row["date"], row["item_name"], row["unit"], row["unit_price"], row["tax_type"])
        if key not in combined:
            combined[key] = row
            row["source_rows"] = [row["source_row"]]
            continue
        target = combined[key]
        duplicate_groups.add((row["source_sheet"], row["item_name"], row["unit_price"]))
        for field in ("opening_stock", "purchase_qty", "sale_qty", "closing_stock", "sales_amount"):
            target[field] += row[field]
        if row["note"]:
            target["note"] = " / ".join(x for x in (target["note"], row["note"]) if x)
        target["source_rows"].append(row["source_row"])
    result = list(combined.values())
    for sheet_name, name, price in duplicate_groups:
        warnings.append(f"{sheet_name}: {name} {price:,}원 중복 행을 합산했습니다.")
    if not result:
        snapshots = _parse_stock_snapshot_workbook(sheets, shared, filename)
        if snapshots:
            result = snapshots
            seen_dates.update(r["date"] for r in snapshots)
            errors = []
            warnings.append("전일재고·금일재고 열이 없어 재고조사 수량으로 반영합니다. 거래 수량은 생성하지 않습니다.")
        else:
            errors.append("날짜별 재고 시트 또는 재고조사 표를 찾지 못했습니다.")
    if errors:
        detail = " / ".join(errors[:6])
        if len(errors) > 6:
            detail += f" / 그 외 {len(errors)-6}건"
        raise ValueError(f"엑셀 검증 실패: {detail}")
    result.sort(key=lambda r: (r["date"], r["source_row"]))
    reports.sort(key=lambda r: r["report_date"])
    validation = {
        "status": "passed", "daily_sheets": len(seen_dates), "rows": len(result),
        "items": len({(r["item_name"], r["unit"], r["unit_price"], r["tax_type"]) for r in result}),
        "date_from": min(seen_dates), "date_to": max(seen_dates),
        "purchase_qty": sum(r["purchase_qty"] for r in result),
        "sale_qty": sum(r["sale_qty"] for r in result), "snapshot_qty": sum(r["closing_stock"] for r in result if r.get("mode") == "snapshot"),
        "mode": "snapshot" if result and all(r.get("mode") == "snapshot" for r in result) else "transactions", "warnings": warnings,
    }
    return (result, reports, validation) if include_reports else result


def import_inventory_rows(db: sqlite3.Connection, imported, reports=None, validation=None):
    if not imported:
        raise ValueError("날짜별 재고 시트를 찾지 못했습니다.")
    dates = sorted({r["date"] for r in imported})
    placeholders = ",".join("?" for _ in dates)
    manual_count = db.execute(
        f"SELECT COUNT(*) FROM transactions WHERE source<>'excel' AND transaction_date IN ({placeholders})",
        dates,
    ).fetchone()[0]
    if manual_count:
        raise ValueError(f"가져올 날짜에 화면에서 입력한 거래가 {manual_count}건 있습니다. 중복 반영을 막기 위해 가져오기를 중단했습니다.")
    db.execute(f"DELETE FROM transactions WHERE source='excel' AND transaction_date IN ({placeholders})", dates)
    db.execute(f"DELETE FROM daily_item_notes WHERE source='excel' AND report_date IN ({placeholders})", dates)
    db.execute(f"DELETE FROM stock_snapshots WHERE source='excel' AND report_date IN ({placeholders})", dates)
    item_ids = {}
    latest_by_item = {}
    def source_item_key(row):
        return (row["item_name"], row["unit"], int(row["unit_price"]), row["tax_type"])
    for row in imported:
        latest_by_item[source_item_key(row)] = row
    for key, row in latest_by_item.items():
        import_key = "xlsx:" + json.dumps(key, ensure_ascii=False, separators=(",", ":"))
        existing = db.execute("SELECT id FROM items WHERE import_key=? LIMIT 1", (import_key,)).fetchone()
        if not existing:
            existing = db.execute(
                "SELECT id FROM items WHERE import_key IS NULL AND name=? AND unit=? AND unit_price=? AND tax_type=? ORDER BY active DESC, id LIMIT 1",
                key,
            ).fetchone()
        if existing:
            item_ids[key] = existing[0]
            db.execute("UPDATE items SET unit_price=?, tax_type=?, active=1, archived_at=NULL, import_key=? WHERE id=?", (row["unit_price"], row["tax_type"], import_key, existing[0]))
        else:
            cur = db.execute("INSERT INTO items(name, unit, unit_price, tax_type, import_key) VALUES (?,?,?,?,?)", (row["item_name"], row["unit"], row["unit_price"], row["tax_type"], import_key))
            item_ids[key] = cur.lastrowid

    rows_by_item = {}
    for row in imported:
        rows_by_item.setdefault(source_item_key(row), []).append(row)
    tx_count = adjustment_count = 0
    snapshot_count = 0
    for key, item_rows in rows_by_item.items():
        item_rows.sort(key=lambda r: r["date"])
        item_id = item_ids[key]
        snapshot_rows = [r for r in item_rows if r.get("mode") == "snapshot"]
        for row in snapshot_rows:
            db.execute(
                "INSERT OR REPLACE INTO stock_snapshots(report_date, item_id, quantity, source, note) VALUES (?,?,?,'excel',?)",
                (row["date"], item_id, int(row["closing_stock"]), row.get("note", "")),
            )
            snapshot_count += 1
        item_rows = [r for r in item_rows if r.get("mode") != "snapshot"]
        if not item_rows:
            continue
        first_date = item_rows[0]["date"]
        running = db.execute(
            """SELECT COALESCE(SUM(CASE WHEN transaction_type IN ('PURCHASE','RETURN_IN','ADJUST_IN')
            THEN quantity ELSE -quantity END),0) FROM transactions WHERE item_id=? AND transaction_date<?""",
            (item_id, first_date),
        ).fetchone()[0]
        for row in item_rows:
            difference = int(row["opening_stock"]) - int(running)
            if difference:
                kind = "ADJUST_IN" if difference > 0 else "ADJUST_OUT"
                db.execute(
                    "INSERT INTO transactions(transaction_date, transaction_type, item_id, quantity, unit_price, note, source) VALUES (?,?,?,?,?,?,?)",
                    (row["date"], kind, item_id, abs(difference), row["unit_price"], "엑셀 전일재고 자동 보정", "excel"),
                )
                tx_count += 1; adjustment_count += 1
            running = int(row["opening_stock"])
            for kind, amount, note in [("PURCHASE", row["purchase_qty"], "엑셀 매입"), ("SALE", row["sale_qty"], "엑셀 매출")]:
                if amount > 0:
                    db.execute("INSERT INTO transactions(transaction_date, transaction_type, item_id, quantity, unit_price, note, source) VALUES (?,?,?,?,?,?,?)", (row["date"], kind, item_id, amount, row["unit_price"], row["note"] or note, "excel")); tx_count += 1
            running += int(row["purchase_qty"]) - int(row["sale_qty"])
            if running != int(row["closing_stock"]):
                raise ValueError(f"{row['source_sheet']} {row['source_row']}행 재고 검증에 실패했습니다.")
            db.execute(
                "INSERT OR REPLACE INTO daily_item_notes(report_date, item_id, note, source) VALUES (?,?,?,'excel')",
                (row["date"], item_id, row["note"]),
            )
    imported_report_dates = set()
    for report in reports or []:
        fields = ["manager", "team_lead", "section_chief", "director", "work_time", "workers", "common_tasks", "work_notes", "digital_lock", "warehouse_door", "activity_content"]
        values = [report.get(field, "") for field in fields]
        db.execute(
            """INSERT INTO daily_reports(report_date, manager, team_lead, section_chief, director, work_time, workers, common_tasks, work_notes, digital_lock, warehouse_door, activity_content, source, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'excel', CURRENT_TIMESTAMP)
            ON CONFLICT(report_date) DO UPDATE SET manager=excluded.manager, team_lead=excluded.team_lead, section_chief=excluded.section_chief, director=excluded.director, work_time=excluded.work_time, workers=excluded.workers, common_tasks=excluded.common_tasks, work_notes=excluded.work_notes, digital_lock=excluded.digital_lock, warehouse_door=excluded.warehouse_door, activity_content=excluded.activity_content, source='excel', updated_at=CURRENT_TIMESTAMP""",
            [report["report_date"], *values],
        )
        if db.execute("SELECT source FROM daily_reports WHERE report_date=?", (report["report_date"],)).fetchone()[0] == "excel":
            imported_report_dates.add(report["report_date"])
    return {"dates": dates, "rows": len(imported), "items": len(item_ids), "transactions": tx_count, "adjustments": adjustment_count, "snapshots": snapshot_count, "reports": len(imported_report_dates), "validation": validation or {"status": "passed"}}




class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def dispatch(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        if method == "GET" and path == "/api/notice/events":
            return self.stream_notices(parse_qs(parsed.query).get("v") == ["2"])
        if method != "GET":
            origin = self.headers.get("Origin")
            if origin and origin != f"http://{self.headers.get('Host')}":
                self.close_connection = True
                return self.send_json({"error": "다른 사이트에서의 변경 요청은 차단됩니다."}, HTTPStatus.FORBIDDEN)
            if not self.headers.get("Content-Type", "").lower().startswith("application/json"):
                self.close_connection = True
                return self.send_json({"error": "JSON 요청만 허용됩니다."}, HTTPStatus.BAD_REQUEST)
        business_id = self.headers.get("X-Business-ID")
        # Old pages must not accidentally mutate the original business.
        global_paths = ("/api/businesses", "/api/welcome", "/api/admin/login", "/api/admin/notice")
        if path.startswith("/api/") and business_id not in BUSINESS_MAP and path not in global_paths:
            self.close_connection = True
            return self.send_json({"error": "사업단을 선택한 뒤 새로고침하세요."}, HTTPStatus.BAD_REQUEST)
        with REQUEST_LOCK, business_scope(business_id if business_id in BUSINESS_MAP else "delivery"):
            try:
                if path.startswith("/api/") and business_id in BUSINESS_MAP and BUSINESS_MAP[business_id]["archived"] and path not in global_paths:
                    raise ValueError("삭제된 사업단입니다. 새로고침 후 다른 사업단을 선택해 주세요.")
                if path.startswith("/api/admin/"):
                    return self.handle_admin(method, path)
                return getattr(self, f"handle_{method}")()
            except ValueError as exc:
                self.close_connection = True
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def admin_session(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            token = cookie["inventory_admin"].value if "inventory_admin" in cookie else ""
        except Exception:
            return ""
        now = time.monotonic()
        for stale in [key for key, expiry in ADMIN_SESSIONS.items() if expiry <= now]:
            del ADMIN_SESSIONS[stale]
        return token if token in ADMIN_SESSIONS else ""

    def stream_notices(self, supports_list):
        def snapshot():
            return [n for n in persistent_notices if n["enabled"]]

        def send(persistent, temp_changed, temp):
            if supports_list:
                data = {"persistent": persistent}
                if temp_changed:
                    data["temporary"] = temp
            else:
                data = temp if temp_changed and temp else next(reversed(persistent), None)
            self.wfile.write(b"data: " + json_bytes(data) + b"\n\n")

        with NOTICE_CHANGED:
            revision, last_temp, initial = notice_revision, temporary_notice, snapshot()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        self.connection.settimeout(5)
        try:
            send(initial, True, None)
            while True:
                with NOTICE_CHANGED:
                    changed = NOTICE_CHANGED.wait_for(lambda: notice_revision != revision, timeout=10)
                    revision, temp = notice_revision, temporary_notice
                    persistent = snapshot() if changed else None
                if changed:
                    send(persistent, temp is not last_temp, temp)
                    last_temp = temp
                else:
                    self.wfile.write(b": heartbeat\n\n")
        except OSError:
            pass

    def handle_admin(self, method, path):
        if path == "/api/admin/login" and method == "POST":
            payload = self.read_json()
            admin_code = os.environ.get("ERP_ADMIN_CODE", "").strip()
            if not admin_code and ADMIN_CODE_PATH.is_file():
                admin_code = ADMIN_CODE_PATH.read_text(encoding="utf-8-sig").strip()
            if not admin_code:
                return self.send_json({"error": "서버에 관리자 코드를 설정하세요."}, HTTPStatus.SERVICE_UNAVAILABLE)
            ip = self.client_address[0]
            attempts, until = LOGIN_FAILURES.get(ip, (0, 0))
            now = time.monotonic()
            if now < until:
                return self.send_json({"error": "입력 횟수를 초과했습니다. 1분 후 다시 시도하세요."}, HTTPStatus.TOO_MANY_REQUESTS)
            if not secrets.compare_digest(str(payload.get("code", "")).encode("utf-8"), admin_code.encode("utf-8")):
                LOGIN_FAILURES[ip] = (attempts + 1, now + 60 if attempts + 1 >= 5 else 0)
                return self.send_json({"error": "관리자 코드가 올바르지 않습니다."}, HTTPStatus.UNAUTHORIZED)
            LOGIN_FAILURES.pop(ip, None)
            old = self.admin_session()
            ADMIN_SESSIONS.pop(old, None)
            token = secrets.token_urlsafe(32)
            ADMIN_SESSIONS[token] = now + 1800
            return self.send_json({"ok": True}, cookie=f"inventory_admin={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800")
        token = self.admin_session()
        if not token:
            self.close_connection = True
            return self.send_json({"error": "관리자 코드 인증이 필요합니다."}, HTTPStatus.UNAUTHORIZED)
        if path == "/api/admin/notice":
            if method == "GET":
                return self.send_json({"persistent": persistent_notices, "temporary": temporary_notice})
            if method == "DELETE":
                self.read_json()
                if temporary_notice is None:
                    raise ValueError("표시 중인 일시형 공지가 없습니다. 지속형은 웹 관리자에서 끌 수 있습니다.")
                set_temporary_notice(None)
                return self.send_json({"ok": True})
            if method == "POST":
                if not 0 < int(self.headers.get("Content-Length", 0)) <= 16000:
                    raise ValueError("공지 입력이 너무 깁니다.")
                payload = self.read_json()
                title = payload.get("title") if isinstance(payload, dict) else None
                message = payload.get("message") if isinstance(payload, dict) else None
                mode = payload.get("mode") if isinstance(payload, dict) else None
                if not isinstance(title, str) or not 1 <= len(title.strip()) <= 80:
                    raise ValueError("제목을 1~80자로 입력해 주세요.")
                if not isinstance(message, str) or not 1 <= len(message.strip()) <= 1000:
                    raise ValueError("내용을 1~1000자로 입력해 주세요.")
                if mode not in ("temporary", "persistent"):
                    raise ValueError("공지 유형을 선택해 주세요.")
                notice = {"id": secrets.token_hex(16), "title": title.strip(), "message": message.strip(), "mode": mode}
                if mode == "persistent":
                    notice.update(enabled=True, created_at=datetime.now().isoformat(timespec="seconds"))
                    save_persistent_notices([*persistent_notices, notice])
                else:
                    set_temporary_notice(notice)
                return self.send_json(notice, HTTPStatus.CREATED)
        match = re.fullmatch(r"/api/admin/notice/([a-f0-9]{32})", path)
        if match and method in ("PUT", "DELETE"):
            notice_id = match[1]
            payload = self.read_json()
            existing = next((notice for notice in persistent_notices if notice["id"] == notice_id), None)
            if existing is None:
                return self.send_json({"error": "공지를 찾을 수 없습니다."}, HTTPStatus.NOT_FOUND)
            if method == "PUT":
                enabled = payload.get("enabled") if isinstance(payload, dict) else None
                if type(enabled) is not bool:
                    raise ValueError("표시 상태를 선택해 주세요.")
                notices = [{**notice, "enabled": enabled} if notice["id"] == notice_id else notice for notice in persistent_notices]
            else:
                notices = [notice for notice in persistent_notices if notice["id"] != notice_id]
            save_persistent_notices(notices)
            return self.send_json({"ok": True})
        if path == "/api/admin/logout" and method == "POST":
            self.read_json()
            ADMIN_SESSIONS.pop(token, None)
            return self.send_json({"ok": True}, cookie="inventory_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0")
        if path == "/api/admin/data/backup" and method == "GET":
            file_format = parse_qs(urlparse(self.path).query).get("format", ["sqlite"])[0]
            business_id = ACTIVE_BUSINESS.get()
            if file_format == "sqlite":
                backup = create_backup("download")
                return self.send_text(backup.read_bytes(), "application/vnd.sqlite3", disposition=f'attachment; filename="{backup.name}"')
            if file_format == "json":
                with database() as db:
                    data = json_bytes(export_data(db))
                return self.send_text(data, "application/json; charset=utf-8", disposition=f'attachment; filename="inventory_{business_id}.json"')
            raise ValueError("SQLite 또는 JSON을 선택해 주세요.")
        if path == "/api/admin/data/restore" and method == "POST":
            if not 0 < int(self.headers.get("Content-Length", 0)) <= (MAX_RESTORE_BYTES * 4 // 3 + 4096):
                raise ValueError("32MB 이하의 백업 파일을 선택해 주세요.")
            payload = self.read_json()
            business = BUSINESS_MAP[ACTIVE_BUSINESS.get()]
            if payload.get("confirmation") != business["name"] + " 복원":
                raise ValueError("확인 문구가 일치하지 않습니다.")
            file_format = payload.get("format")
            if file_format not in ("sqlite", "json"):
                raise ValueError("SQLite 또는 JSON을 선택해 주세요.")
            raw = base64.b64decode(payload.get("data", ""), validate=True)
            if len(raw) > MAX_RESTORE_BYTES:
                raise ValueError("32MB 이하의 백업 파일을 선택해 주세요.")
            with database() as db:
                return self.send_json({"backup": restore_data(db, raw, file_format)})
        if path == "/api/admin/businesses":
            if method == "GET":
                return self.send_json(list(BUSINESS_MAP.values()))
            if method == "POST":
                template = business_template(self.read_json())
                if any(b["name"] == template["name"] for b in active_businesses()):
                    raise ValueError("이미 사용 중인 사업단 이름입니다.")
                business = {**template, "id": "b_" + secrets.token_hex(8), "archived": False}
                new_id = business["id"]
                BUSINESS_MAP[new_id] = business
                try:
                    with business_scope(new_id):
                        init_db()
                    save_business(business)
                except Exception:
                    BUSINESS_MAP.pop(new_id, None)
                    raise
                return self.send_json(business, HTTPStatus.CREATED)
        match = re.fullmatch(r"/api/admin/businesses/([a-z0-9_]+)", path)
        if match and method in ("PUT", "DELETE"):
            business = BUSINESS_MAP.get(match[1])
            if not business:
                raise ValueError("등록되지 않은 사업단입니다.")
            payload = self.read_json()
            if method == "DELETE":
                if len(active_businesses()) <= 1 and not business["archived"]:
                    raise ValueError("사업단은 한 곳 이상 남아 있어야 합니다.")
                if payload.get("confirmation") != business["name"] + " 삭제":
                    raise ValueError("확인 문구가 일치하지 않습니다.")
                business = {**business, "archived": True}
            else:
                template = business_template({"production_enabled": business["production_enabled"], **payload})
                if any(b["id"] != business["id"] and b["name"] == template["name"] for b in active_businesses()):
                    raise ValueError("이미 사용 중인 사업단 이름입니다.")
                business = {**business, **template, "archived": False}
            save_business(business)
            return self.send_json(business)
        if path == "/api/admin/welcome" and method == "PUT":
            payload = self.read_json()
            settings = {}
            for key, label, limit in (("title", "제목", 80), ("message", "안내 문구", 500)):
                value = payload.get(key) if isinstance(payload, dict) else None
                if not isinstance(value, str) or not 1 <= len(value.strip()) <= limit:
                    raise ValueError(f"{label}은(는) 1~{limit}자로 입력해 주세요.")
                settings[key] = value.strip()
            with business_scope("delivery"), database() as db:
                db.executemany(
                    "INSERT OR REPLACE INTO welcome_settings(key, value) VALUES (?, ?)",
                    settings.items(),
                )
            return self.send_json(settings)
        if path == "/api/admin/summary" and method == "GET":
            query = parse_qs(urlparse(self.path).query)
            today = date.today()
            start = date.fromisoformat(query.get("from", [today.replace(day=1).isoformat()])[0])
            end = date.fromisoformat(query.get("to", [today.isoformat()])[0])
            if start > end:
                raise ValueError("시작일은 종료일보다 늦을 수 없습니다.")
            businesses = []
            for business in active_businesses():
                with business_scope(business["id"]), database() as db:
                    items = get_items(db)
                    sales = db.execute("SELECT COALESCE(SUM(quantity*unit_price),0) FROM transactions WHERE transaction_type='SALE' AND transaction_date BETWEEN ? AND ?", (start.isoformat(), end.isoformat())).fetchone()[0]
                    businesses.append({**business, "sales_amount": sales, "item_count": len(items),
                        "low_stock": [i for i in items if i.get("item_type", "STOCK") == "STOCK" and 0 < i["stock"] <= i["min_stock"]],
                        "out_of_stock": [i for i in items if i.get("item_type", "STOCK") == "STOCK" and i["stock"] <= 0]})
            return self.send_json({"from": start.isoformat(), "to": end.isoformat(), "businesses": businesses,
                "sales_amount": sum(b["sales_amount"] for b in businesses),
                "low_count": sum(len(b["low_stock"]) for b in businesses),
                "out_count": sum(len(b["out_of_stock"]) for b in businesses)})
        if path == "/api/admin/reset-business" and method == "POST":
            payload = self.read_json()
            business_id = payload.get("business_id")
            if business_id not in BUSINESS_MAP:
                raise ValueError("등록되지 않은 사업단입니다.")
            if payload.get("confirmation") != f"{BUSINESS_MAP[business_id]['name']} 초기화":
                raise ValueError("사업단 이름을 포함한 확인 문구를 정확히 입력하세요.")
            # The administrator may reset any business from the central dashboard.
            # Switch the database scope explicitly so the request's currently
            # selected business does not limit the target.
            with business_scope(business_id):
                init_db()
                backup = create_backup("before_reset")
                with database() as db:
                    counts = {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in DATA_TABLES}
                    for table in reversed(DATA_TABLES):
                        db.execute(f"DELETE FROM {table}")
                    # Keep sequences monotonic so stale forms cannot target a new item.
            return self.send_json({"ok": True, "business_id": business_id, "deleted": counts, "backup": backup.name})
        if path == "/api/admin/hard-delete-item" and method == "POST":
            payload = self.read_json()
            item_id = int(payload.get("item_id", 0))
            if payload.get("confirmation") != "완전삭제":
                raise ValueError("확인 문구를 정확히 입력하세요.")
            with database() as db:
                row = db.execute("SELECT id, name FROM items WHERE id=?", (item_id,)).fetchone()
                if not row:
                    return self.send_json({"error": "품목을 찾을 수 없습니다."}, HTTPStatus.NOT_FOUND)
                if db.execute(
                    """SELECT 1 FROM production_components WHERE finished_id=? OR item_id=? OR package_id=?
                       UNION ALL SELECT 1 FROM transactions WHERE item_id=? AND source LIKE ?""",
                    (item_id, item_id, item_id, item_id, SOURCE_PREFIX + "%"),
                ).fetchone():
                    raise ValueError("생산 구성이나 생산 기록에 연결된 품목입니다. 거래 기록을 보존하려면 품목을 사용중지해 주세요.")
                backup = create_backup("before_hard_delete")
                db.execute("DELETE FROM daily_item_notes WHERE item_id=?", (item_id,))
                db.execute("DELETE FROM stock_snapshots WHERE item_id=?", (item_id,))
                db.execute("DELETE FROM transactions WHERE item_id=?", (item_id,))
                db.execute("DELETE FROM items WHERE id=?", (item_id,))
            return self.send_json({"ok": True, "deleted": dict(row), "backup": backup.name})
        return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")

    def send_json(self, payload, status=HTTPStatus.OK, cookie=None):
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, body: bytes, content_type: str, status=HTTPStatus.OK, disposition=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if disposition:
            self.send_header("Content-Disposition", disposition)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        size = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(size) or b"{}")

    def handle_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        try:
            if path == "/" or path == "/index.html":
                return self.send_text((STATIC / "index.html").read_bytes(), "text/html; charset=utf-8")
            if path.startswith("/static/"):
                file = (STATIC / path.removeprefix("/static/")).resolve()
                if not file.is_relative_to(STATIC.resolve()):
                    return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
                if file.exists() and file.is_file():
                    content_type = {
                        ".js": "text/javascript; charset=utf-8",
                        ".css": "text/css; charset=utf-8",
                        ".woff2": "font/woff2",
                        ".txt": "text/plain; charset=utf-8",
                    }.get(file.suffix, "application/octet-stream")
                    return self.send_text(file.read_bytes(), content_type)
                return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            if path == "/api/businesses":
                return self.send_json(active_businesses())
            if path == "/api/welcome":
                return self.send_json(get_welcome_settings())
            with database() as db:
                if path == "/api/production":
                    if not BUSINESS_MAP[ACTIVE_BUSINESS.get()]["production_enabled"]:
                        raise ValueError("이 사업단은 생산 기능이 꺼져 있습니다.")
                    return self.send_json(list_production(db))
                if path == "/api/summary":
                    return self.send_json(get_summary(db))
                if path == "/api/items":
                    include_inactive = query.get("all", ["0"])[0] == "1"
                    return self.send_json(get_items(db, include_inactive))
                if path == "/api/partners":
                    return self.send_json([dict(r) for r in db.execute("SELECT * FROM partners WHERE active=1 ORDER BY name").fetchall()])
                if path == "/api/transactions":
                    clauses, params = [], []
                    if query.get("from"):
                        from_date = query["from"][0]
                        date.fromisoformat(from_date)
                        clauses.append("t.transaction_date >= ?"); params.append(from_date)
                    if query.get("to"):
                        to_date = query["to"][0]
                        date.fromisoformat(to_date)
                        clauses.append("t.transaction_date <= ?"); params.append(to_date)
                    if query.get("from") and query.get("to") and query["from"][0] > query["to"][0]:
                        raise ValueError("시작일은 종료일보다 늦을 수 없습니다.")
                    if query.get("item_id"):
                        clauses.append("t.item_id = ?"); params.append(int(query["item_id"][0]))
                    if query.get("partner_id"):
                        clauses.append("t.partner_id = ?"); params.append(int(query["partner_id"][0]))
                    if query.get("type"):
                        transaction_type = query["type"][0]
                        if transaction_type not in ("PURCHASE", "SALE", "ISSUE", "RETURN_IN", "RETURN_OUT", "ADJUST_IN", "ADJUST_OUT"):
                            raise ValueError("거래유형이 올바르지 않습니다.")
                        clauses.append("t.transaction_type = ?"); params.append(transaction_type)
                    if query.get("q"):
                        keyword = query["q"][0].strip()
                        if keyword:
                            clauses.append("(i.name LIKE ? OR COALESCE(p.name,'') LIKE ? OR t.note LIKE ?)")
                            pattern = f"%{keyword}%"; params.extend([pattern, pattern, pattern])
                    where = " WHERE " + " AND ".join(clauses) if clauses else ""
                    rows = db.execute(
                        f"""SELECT t.*, i.name item_name, i.unit, COALESCE(p.name,'') partner_name
                        FROM transactions t JOIN items i ON i.id=t.item_id LEFT JOIN partners p ON p.id=t.partner_id
                        {where} ORDER BY t.transaction_date DESC, t.id DESC LIMIT 1000""", params).fetchall()
                    return self.send_json([dict(r) for r in rows])
                if path == "/api/daily-sheet":
                    day = query.get("date", [date.today().isoformat()])[0]
                    start = date.fromisoformat(query.get("from", [day])[0])
                    end = date.fromisoformat(query.get("to", [day])[0])
                    if start > end or start == date.min:
                        raise ValueError("조회 기간을 확인해 주세요.")
                    partner_id = None
                    partner_name = ""
                    if "partner_id" in query:
                        partner_id = int(query["partner_id"][0])
                        partner = db.execute("SELECT name FROM partners WHERE id=?", (partner_id,)).fetchone()
                        if not partner:
                            raise ValueError("기관·거래처를 다시 선택해 주세요.")
                        partner_name = partner["name"]
                    first, last = start.isoformat(), end.isoformat()
                    detail = query.get("mode") == ["transactions"]
                    if detail:
                        rows = db.execute(
                            """SELECT t.transaction_date, t.transaction_type, t.quantity, t.unit_price, t.note, t.source,
                                      i.name AS item_name, i.unit, COALESCE(p.name, '') AS partner_name
                               FROM transactions t JOIN items i ON i.id=t.item_id
                               LEFT JOIN partners p ON p.id=t.partner_id
                               WHERE t.transaction_date BETWEEN :start AND :end
                                 AND (:partner IS NULL OR t.partner_id=:partner)
                               ORDER BY t.transaction_date, t.id""",
                            {"start": first, "end": last, "partner": partner_id},
                        ).fetchall()
                    return self.send_json({
                        "date": last, "from": first, "to": last, "partner": partner_name,
                        "mode": "transactions" if detail else "summary",
                        "rows": [dict(row) for row in rows] if detail else get_daily_sheet(db, first, last, partner_id),
                    })
                if path == "/api/daily-report":
                    target_date = query.get("date", [date.today().isoformat()])[0]
                    return self.send_json(get_daily_report(db, target_date))
                if path == "/api/monthly-summary":
                    target_month = query.get("month", [date.today().strftime("%Y-%m")])[0]
                    return self.send_json(get_monthly_summary(db, target_month))
                if path == "/api/calendar-summary":
                    month = query.get("month", [date.today().strftime("%Y-%m")])[0]
                    return self.send_json(get_calendar_summary(db, month))
            return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except ValueError as exc:
            return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            return self.send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def handle_POST(self):
        path = urlparse(self.path).path
        try:
            payload = self.read_json()
            if path in ("/api/production/recipe", "/api/production/batch"):
                if not BUSINESS_MAP[ACTIVE_BUSINESS.get()]["production_enabled"]:
                    raise ValueError("이 사업단은 생산 기능이 꺼져 있습니다.")
                if not isinstance(payload, dict):
                    raise ValueError("생산 입력을 확인해 주세요.")
                with database() as db:
                    if path.endswith("/recipe"):
                        db.execute("BEGIN IMMEDIATE")
                        save_recipe(db, payload)
                        result = {"ok": True}
                    else:
                        result = {"id": record_production(db, payload)}
                return self.send_json(result)
            with database() as db:
                if path == "/api/items":
                    name = str(payload.get("name", "")).strip()
                    if not name: raise ValueError("품목명을 입력하세요.")
                    unit = str(payload.get("unit", "개")).strip() or "개"
                    duplicate = db.execute("SELECT id, active FROM items WHERE name=? AND unit=?", (name, unit)).fetchone()
                    if duplicate:
                        if duplicate["active"]:
                            raise ValueError("같은 품목명과 단위가 이미 등록되어 있습니다.")
                        raise ValueError("사용중지된 같은 품목이 있습니다. 목록에서 복구하세요.")
                    item_type = str(payload.get("item_type", "STOCK"))
                    if item_type not in ("STOCK", "SERVICE"): raise ValueError("품목 유형이 올바르지 않습니다.")
                    min_stock = 0 if item_type == "SERVICE" else int(payload.get("min_stock", 0))
                    cur = db.execute("INSERT INTO items(name, unit, unit_price, tax_type, min_stock, item_type) VALUES (?,?,?,?,?,?)", (name, unit, int(payload.get("unit_price", 0)), payload.get("tax_type", "면세"), min_stock, item_type))
                    return self.send_json({"id": cur.lastrowid})
                match = re.fullmatch(r"/api/items/(\d+)/restore", path)
                if match:
                    item_id = int(match.group(1))
                    cur = db.execute("UPDATE items SET active=1, archived_at=NULL WHERE id=?", (item_id,))
                    if not cur.rowcount:
                        return self.send_json({"error": "품목을 찾을 수 없습니다."}, HTTPStatus.NOT_FOUND)
                    return self.send_json({"ok": True})
                if path == "/api/partners":
                    name = str(payload.get("name", "")).strip()
                    if not name: raise ValueError("기관명을 입력하세요.")
                    cur = db.execute("INSERT OR IGNORE INTO partners(name, kind) VALUES (?,?)", (name, payload.get("kind", "기관")))
                    return self.send_json({"id": cur.lastrowid or db.execute("SELECT id FROM partners WHERE name=?", (name,)).fetchone()[0]})
                if path == "/api/transactions":
                    item_id = int(payload["item_id"])
                    kind = payload["transaction_type"]
                    mode = payload.get("adjustment_mode") if kind == "ADJUST" else None
                    if kind == "ADJUST":
                        if mode not in ("increase", "decrease", "set"):
                            raise ValueError("재고 조정 방법을 선택하세요.")
                        try:
                            qty = int(str(payload.get("quantity", "")))
                        except ValueError:
                            raise ValueError("수량은 정수로 입력하세요.") from None
                    else:
                        qty = int(payload["quantity"])
                    if mode == "set":
                        if qty < 0:
                            raise ValueError("변경 후 재고는 0 이상이어야 합니다.")
                    elif qty <= 0:
                        raise ValueError("수량은 1 이상이어야 합니다.")

                    db.execute("BEGIN IMMEDIATE")
                    item_type = db.execute("SELECT item_type FROM items WHERE id=? AND active=1", (item_id,)).fetchone()
                    if not item_type:
                        raise ValueError("사용 중인 품목을 찾을 수 없습니다.")
                    if kind in ("ADJUST", "ADJUST_IN", "ADJUST_OUT") and item_type[0] != "STOCK":
                        raise ValueError("재고품만 재고를 조정할 수 있습니다.")
                    if mode == "set":
                        difference = qty - current_stock(db, item_id)
                        if difference == 0:
                            db.commit()
                            return self.send_json({"unchanged": True})
                        kind = "ADJUST_IN" if difference > 0 else "ADJUST_OUT"
                        qty = abs(difference)
                    elif mode:
                        kind = "ADJUST_IN" if mode == "increase" else "ADJUST_OUT"
                    if mode != "set" and item_type[0] == "STOCK" and kind in ("SALE", "ISSUE", "RETURN_OUT", "ADJUST_OUT") and current_stock(db, item_id) < qty:
                        raise ValueError("현재 재고보다 많은 수량을 출고할 수 없습니다.")
                    cur = db.execute("INSERT INTO transactions(transaction_date, transaction_type, item_id, partner_id, quantity, unit_price, note) VALUES (?,?,?,?,?,?,?)", (payload.get("transaction_date") or date.today().isoformat(), kind, item_id, payload.get("partner_id") or None, qty, int(payload.get("unit_price", 0)), str(payload.get("note", ""))))
                    db.commit()
                    return self.send_json({"id": cur.lastrowid})
                if path == "/api/import-workbook":
                    encoded = str(payload.get("data", ""))
                    if not encoded:
                        raise ValueError("엑셀 파일 데이터가 없습니다.")
                    imported, reports, validation = parse_inventory_workbook(encoded, include_reports=True, filename=str(payload.get("filename", "")))
                    create_backup("before_excel_import")
                    return self.send_json(import_inventory_rows(db, imported, reports, validation))
                if path == "/api/daily-report":
                    report_date = str(payload.get("report_date") or date.today().isoformat())
                    fields = ["manager", "team_lead", "section_chief", "director", "work_time", "workers", "common_tasks", "work_notes", "digital_lock", "warehouse_door", "activity_content"]
                    values = [str(payload.get(field, "")).strip() for field in fields]
                    db.execute(
                        """INSERT INTO daily_reports(report_date, manager, team_lead, section_chief, director, work_time, workers, common_tasks, work_notes, digital_lock, warehouse_door, activity_content, updated_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
                        ON CONFLICT(report_date) DO UPDATE SET manager=excluded.manager, team_lead=excluded.team_lead, section_chief=excluded.section_chief, director=excluded.director, work_time=excluded.work_time, workers=excluded.workers, common_tasks=excluded.common_tasks, work_notes=excluded.work_notes, digital_lock=excluded.digital_lock, warehouse_door=excluded.warehouse_door, activity_content=excluded.activity_content, source='manual', updated_at=CURRENT_TIMESTAMP""",
                        [report_date, *values],
                    )
                    return self.send_json(get_daily_report(db, report_date))
            return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except sqlite3.IntegrityError as exc:
            return self.send_json({"error": "중복된 값이거나 잘못된 데이터입니다."}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def handle_PUT(self):
        path = urlparse(self.path).path
        try:
            payload = self.read_json()
            match = re.fullmatch(r"/api/items/(\d+)", path)
            if not match:
                return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            item_id = int(match.group(1))
            name = str(payload.get("name", "")).strip()
            unit = str(payload.get("unit", "개")).strip() or "개"
            if not name:
                raise ValueError("품목명을 입력하세요.")
            unit_price = int(payload.get("unit_price", 0))
            min_stock = int(payload.get("min_stock", 0))
            if unit_price < 0 or min_stock < 0:
                raise ValueError("단가와 최소재고는 0 이상이어야 합니다.")
            tax_type = str(payload.get("tax_type", "면세"))
            if tax_type not in ("면세", "과세"):
                raise ValueError("과세구분이 올바르지 않습니다.")
            item_type = str(payload.get("item_type", "STOCK"))
            if item_type not in ("STOCK", "SERVICE"):
                raise ValueError("품목 유형이 올바르지 않습니다.")
            if item_type == "SERVICE":
                min_stock = 0
            with database() as db:
                duplicate = db.execute("SELECT id FROM items WHERE name=? AND unit=? AND id<>?", (name, unit, item_id)).fetchone()
                if duplicate:
                    raise ValueError("같은 품목명과 단위가 이미 등록되어 있습니다.")
                cur = db.execute(
                    "UPDATE items SET name=?, unit=?, unit_price=?, tax_type=?, min_stock=?, item_type=? WHERE id=?",
                    (name, unit, unit_price, tax_type, min_stock, item_type, item_id),
                )
                if not cur.rowcount:
                    return self.send_json({"error": "품목을 찾을 수 없습니다."}, HTTPStatus.NOT_FOUND)
                return self.send_json({"ok": True})
        except Exception as exc:
            return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def handle_DELETE(self):
        path = urlparse(self.path).path
        try:
            with database() as db:
                if path.startswith("/api/items/"):
                    item_id = int(path.rsplit("/", 1)[1])
                    item = db.execute("SELECT active FROM items WHERE id=?", (item_id,)).fetchone()
                    if not item:
                        return self.send_json({"error": "품목을 찾을 수 없습니다."}, HTTPStatus.NOT_FOUND)
                    if not item["active"]:
                        return self.send_json({"ok": True})
                    db.execute("UPDATE items SET active=0, archived_at=CURRENT_TIMESTAMP WHERE id=?", (item_id,))
                    return self.send_json({"ok": True})
                if path.startswith("/api/transactions/"):
                    tx_id = int(path.rsplit("/", 1)[1])
                    row = db.execute("SELECT source FROM transactions WHERE id=?", (tx_id,)).fetchone()
                    if row and row["source"].startswith(SOURCE_PREFIX):
                        raise ValueError("생산에 연결된 재고 변동은 개별 삭제할 수 없습니다.")
                    db.execute("DELETE FROM transactions WHERE id=?", (tx_id,))
                    return self.send_json({"ok": True})
            return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except Exception as exc:
            return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)


if __name__ == "__main__":
    load_notices()
    load_business_catalog()
    for business in BUSINESS_MAP.values():
        with business_scope(business["id"]):
            init_db()
            create_daily_backup()
    host = os.environ.get("ERP_HOST", "192.168.100.117")
    port = int(os.environ.get("ERP_PORT", "8000"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"재고관리 프로그램이 실행되었습니다: http://{host}:{port}")
    if "--launcher" in sys.argv:
        def wait_for_launcher():
            sys.stdin.readline()
            server.shutdown()
        threading.Thread(target=wait_for_launcher, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with REQUEST_LOCK:
            server.server_close()
