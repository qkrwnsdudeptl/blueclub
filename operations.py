"""Stock counts, work logs, café consumption and operational reports."""
import json
import re
from calendar import monthrange
from datetime import date, timedelta
from fractions import Fraction
from math import ceil
from statistics import median

from production import available_stock, positive_int, record_production, stock_item

TABLES = ("inventory_policy", "inventory_counts", "work_logs", "cafe_recipes", "incoming_orders")
COUNT_SOURCE = "count:"
CAFE_SOURCE = "cafe:"
WASTE_SOURCE = "waste"
INBOUND = "('PURCHASE','RETURN_IN','ADJUST_IN')"


def init_operations(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS inventory_policy (
            item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
            frequency TEXT NOT NULL CHECK(frequency IN ('daily','monthly')),
            mode TEXT NOT NULL CHECK(mode IN ('ledger','snapshot')),
            lead_days INTEGER CHECK(lead_days BETWEEN 1 AND 365)
        );
        CREATE TABLE IF NOT EXISTS inventory_counts (
            count_date TEXT NOT NULL,
            item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
            quantity INTEGER NOT NULL CHECK(quantity >= 0),
            note TEXT NOT NULL,
            book_quantity INTEGER,
            finalized_mode TEXT CHECK(finalized_mode IN ('ledger','snapshot')),
            PRIMARY KEY(count_date, item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_count_item_date ON inventory_counts(item_id,count_date);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cafe_sale_token ON transactions(source) WHERE source GLOB 'manual-sale:*';
        CREATE TABLE IF NOT EXISTS work_logs (
            id TEXT PRIMARY KEY,
            work_date TEXT NOT NULL,
            item_id INTEGER NOT NULL REFERENCES items(id),
            workers INTEGER NOT NULL CHECK(workers > 0),
            person_minutes INTEGER NOT NULL CHECK(person_minutes > 0),
            quantity INTEGER NOT NULL CHECK(quantity >= 0),
            defective INTEGER NOT NULL CHECK(defective >= 0),
            note TEXT NOT NULL,
            recipe TEXT NOT NULL CHECK(json_valid(recipe)),
            usage TEXT NOT NULL CHECK(json_valid(usage)),
            status TEXT NOT NULL CHECK(status IN ('pending','posted','recorded')),
            issue TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_work_date ON work_logs(work_date);
        CREATE TABLE IF NOT EXISTS cafe_recipes (
            menu_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
            item_id INTEGER NOT NULL REFERENCES items(id),
            quantity INTEGER NOT NULL CHECK(quantity > 0),
            PRIMARY KEY(menu_id,item_id), CHECK(menu_id<>item_id)
        );
        CREATE TABLE IF NOT EXISTS incoming_orders (
            id TEXT PRIMARY KEY,
            item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
            due_date TEXT NOT NULL,
            quantity INTEGER NOT NULL CHECK(quantity > 0),
            note TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('open','received','cancelled')),
            received_tx INTEGER REFERENCES transactions(id) ON DELETE SET NULL
        );
    """)


def whole(value, label, minimum=0, maximum=1_000_000_000):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{label}은(는) {minimum:,}~{maximum:,} 사이의 정수로 입력해 주세요.")
    return value


def day_value(value, *, allow_future=False):
    try:
        day = date.fromisoformat(value)
    except (ValueError, TypeError):
        raise ValueError("날짜를 확인해 주세요.") from None
    if day < date(1900, 1, 1) or (not allow_future and day > date.today()):
        raise ValueError("기록 날짜를 확인해 주세요.")
    return day


def month_dates(value):
    try:
        first = day_value(value + "-01")
    except (ValueError, TypeError):
        raise ValueError("조회 월을 확인해 주세요.") from None
    return first, first.replace(day=monthrange(first.year, first.month)[1])


def text_field(payload, name="note"):
    value = str(payload.get(name, "")).strip()
    if len(value) > 300:
        raise ValueError("비고는 300자 이하로 입력해 주세요.")
    return value


def request_token(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{32}", value):
        raise ValueError("요청이 올바르지 않습니다. 화면을 새로고침해 주세요.")
    return value


def asof_stock(db, item_id, day):
    return db.execute(f"""SELECT COALESCE(SUM(CASE WHEN transaction_type IN {INBOUND}
        THEN quantity ELSE -quantity END),0) FROM transactions
        WHERE item_id=? AND transaction_date<=?""", (item_id,str(day))).fetchone()[0]


def ensure_open(db, item_id, day):
    closed = db.execute("""SELECT MAX(count_date) FROM inventory_counts
        WHERE item_id=? AND count_date>=? AND finalized_mode='ledger'""", (item_id,str(day))).fetchone()[0]
    if closed:
        raise ValueError(f"{closed} 실사로 확정된 기간입니다. 해당 실사를 다시 연 뒤 거래를 변경해 주세요.")


def policy_rows(db):
    return [dict(row) for row in db.execute("""
        SELECT i.id,i.name,i.unit,i.min_stock,COALESCE(p.frequency,'monthly') frequency,
            COALESCE(p.mode,'ledger') mode,p.lead_days
        FROM items i LEFT JOIN inventory_policy p ON i.id=p.item_id
        WHERE i.active=1 AND i.item_type='STOCK' ORDER BY i.id
    """)]


def save_policy(db, payload):
    item_id = positive_int(payload.get("item_id"), "품목")
    stock_item(db, item_id)
    frequency, mode = payload.get("frequency"), payload.get("mode")
    if frequency not in ("daily", "monthly") or mode not in ("ledger", "snapshot"):
        raise ValueError("실사 주기와 재고 관리 방식을 확인해 주세요.")
    lead = payload.get("lead_days")
    if lead is not None:
        lead = whole(lead, "입고 소요일", 1, 365)
    if mode == "snapshot":
        if db.execute("""SELECT 1 FROM production_components WHERE finished_id=? OR item_id=? OR package_id=?
            UNION ALL SELECT 1 FROM cafe_recipes WHERE item_id=? OR menu_id=?
            UNION ALL SELECT 1 FROM incoming_orders WHERE item_id=? AND status='open'""",
            (item_id,) * 6).fetchone():
            raise ValueError("생산·카페 레시피 또는 미입고 발주에 연결된 품목은 장부를 추적해야 합니다.")
        lead = None
    db.execute("""INSERT INTO inventory_policy VALUES (?,?,?,?)
        ON CONFLICT(item_id) DO UPDATE SET frequency=excluded.frequency,mode=excluded.mode,lead_days=excluded.lead_days""",
        (item_id, frequency, mode, lead))
    return {"ok": True}


def count_date(payload):
    if payload.get("scope") == "monthly":
        _, day = month_dates(payload.get("month", ""))
        return day
    if payload.get("scope") != "daily":
        raise ValueError("실사 구분을 확인해 주세요.")
    return day_value(payload.get("date", date.today().isoformat()))


def counts(db, payload):
    day = count_date(payload)
    day_key = day.isoformat()
    rows = []
    for item in policy_rows(db):
        if payload["scope"] == "daily" and item["frequency"] != "daily":
            continue
        current = db.execute("SELECT * FROM inventory_counts WHERE item_id=? AND count_date=?", (item["id"],day_key)).fetchone()
        last = db.execute("""SELECT report_date,quantity FROM stock_snapshots
            WHERE item_id=? AND report_date<=? ORDER BY report_date DESC, (source='count') DESC LIMIT 1""",
            (item["id"],day_key)).fetchone()
        book = asof_stock(db, item["id"], day_key) if item["mode"] == "ledger" else None
        rows.append({**item, "book": book, "count": dict(current) if current else None, "last": dict(last) if last else None})
    return {"date": day_key, "can_finalize": day <= date.today(), "items": rows}


def change_counts(db, payload):
    day = count_date(payload)
    if day > date.today():
        raise ValueError("월말 날짜가 도래한 뒤 실사를 저장하거나 확정할 수 있습니다.")
    day_key = day.isoformat()
    action = payload.get("action")
    if action not in ("save", "finalize", "reopen", "clear"):
        raise ValueError("실사 작업을 선택해 주세요.")
    entries = payload.get("entries")
    if not isinstance(entries, list) or not 1 <= len(entries) <= 2000:
        raise ValueError("처리할 실사 품목을 선택해 주세요.")
    policies = {i["id"]: i for i in policy_rows(db)}
    processed = 0
    seen = set()
    for entry in entries:
        item_id = positive_int(entry.get("item_id"), "품목")
        item = policies.get(item_id)
        if not item or (payload["scope"] == "daily" and item["frequency"] != "daily") or item_id in seen:
            raise ValueError("실사 대상 품목을 다시 확인해 주세요.")
        seen.add(item_id)
        existing = db.execute("SELECT * FROM inventory_counts WHERE count_date=? AND item_id=?", (day_key,item_id)).fetchone()
        source = f"{COUNT_SOURCE}{day}:{item_id}"
        if action == "clear":
            db.execute("DELETE FROM inventory_counts WHERE count_date=? AND item_id=? AND finalized_mode IS NULL", (day_key,item_id))
            continue
        if action == "reopen":
            if not existing or not existing["finalized_mode"]:
                continue
            ensure_open(db, item_id, day + timedelta(days=1))
            db.execute("DELETE FROM transactions WHERE source=? AND item_id=?", (source, item_id))
            db.execute("DELETE FROM stock_snapshots WHERE report_date=? AND item_id=? AND source='count'", (day_key,item_id))
            db.execute("""UPDATE inventory_counts SET finalized_mode=NULL,book_quantity=NULL
                WHERE count_date=? AND item_id=?""", (day_key,item_id))
            processed += 1
            continue
        quantity = whole(entry.get("quantity"), "실사 수량")
        note = text_field(entry)
        if existing and existing["finalized_mode"]:
            if action == "finalize" and (quantity, note) == (existing["quantity"], existing["note"]):
                continue
            raise ValueError(f"{item['name']}은(는) 확정된 실사입니다. 먼저 다시 열어 주세요.")
        mode = item["mode"] if action == "finalize" else None
        book = None
        if mode == "ledger":
            ensure_open(db, item_id, day)
            book = asof_stock(db, item_id, day)
            if entry.get("book") != book:
                raise ValueError(f"{item['name']} 장부 수량이 바뀌었습니다. 목록을 다시 조회하고 차이를 확인해 주세요.")
            delta = quantity - book
            if delta:
                db.execute("""INSERT INTO transactions(transaction_date,transaction_type,item_id,quantity,unit_price,note,source)
                    VALUES (?,?,?,?,0,?,?)""", (day_key, "ADJUST_IN" if delta > 0 else "ADJUST_OUT", item_id,
                    abs(delta), "재고 실사 차이" + (f" · {note}" if note else ""), source))
        if mode:
            db.execute("""INSERT OR REPLACE INTO stock_snapshots(report_date,item_id,quantity,source,note)
                VALUES (?,?,?,'count',?)""", (day_key,item_id,quantity,note))
        db.execute("""INSERT INTO inventory_counts VALUES (?,?,?,?,?,?)
            ON CONFLICT(count_date,item_id) DO UPDATE SET quantity=excluded.quantity,note=excluded.note,
            book_quantity=excluded.book_quantity,finalized_mode=excluded.finalized_mode""",
            (day_key,item_id,quantity,note,book,mode))
        processed += 1
    return {"processed": processed}


def work_logs(db, month):
    first, last = month_dates(month)
    return [dict(row) for row in db.execute("""SELECT w.id,w.work_date,w.item_id,w.workers,w.person_minutes,
        w.quantity,w.defective,w.note,w.status,w.issue,i.name,i.unit
        FROM work_logs w JOIN items i ON i.id=w.item_id WHERE w.work_date BETWEEN ? AND ?
        ORDER BY w.work_date DESC,w.rowid DESC""", (first.isoformat(),last.isoformat()))]


def post_work(db, row):
    recipe = json.loads(row["recipe"])
    usage = json.loads(row["usage"])
    if not recipe:
        recipe = [dict(r) for r in db.execute("SELECT * FROM production_components WHERE finished_id=? ORDER BY item_id", (row["item_id"],))]
        db.execute("UPDATE work_logs SET recipe=? WHERE id=?", (json.dumps(recipe), row["id"]))
    status, issue = "posted", ""
    try:
        record_production(db, {"request_id":row["id"], "finished_id":row["item_id"],
                               "quantity":row["quantity"], "note":row["note"]},
                          work_date=row["work_date"], recipe=recipe, usage=usage,
                          check_open=lambda item_id, day: ensure_open(db,item_id,day))
    except ValueError as exc:
        status, issue = "pending", str(exc)
    db.execute("UPDATE work_logs SET status=?,issue=? WHERE id=?", (status,issue,row["id"]))
    return {"id": row["id"], "status": status, "issue": issue}


def save_work(db, payload):
    token = request_token(payload.get("id"))
    if payload.get("action") not in ("save", "retry"):
        raise ValueError("작업일지 작업을 확인해 주세요.")
    existing = db.execute("SELECT * FROM work_logs WHERE id=?", (token,)).fetchone()
    if payload["action"] == "retry":
        if not existing:
            raise ValueError("다시 반영할 작업일지를 찾을 수 없습니다.")
        return post_work(db, existing) if existing["status"] == "pending" else {"id":token,"status":existing["status"],"issue":existing["issue"]}
    if existing:
        return {"id":token,"status":existing["status"],"issue":existing["issue"]}
    day = day_value(payload.get("work_date")).isoformat()
    item_id = positive_int(payload.get("item_id"), "작업 품목")
    stock_item(db, item_id)
    workers = whole(payload.get("workers"), "참여 인원", 1, 10000)
    minutes = whole(payload.get("person_minutes"), "전체 참여 시간(분)", workers, 10_000_000)
    quantity = whole(payload.get("quantity"), "정상 완성 수량")
    defective = whole(payload.get("defective", 0), "불량 수량")
    note = text_field(payload)
    recipe = [dict(row) for row in db.execute("SELECT * FROM production_components WHERE finished_id=? ORDER BY item_id", (item_id,))]
    overrides = payload.get("usage", {})
    material_ids = {str(row["item_id"]) for row in recipe}
    if not isinstance(overrides, dict) or not overrides.keys() <= material_ids:
        raise ValueError("실제 사용량을 입력할 재료를 확인해 주세요.")
    usage = {key:whole(value, "실제 재료 사용량") for key,value in overrides.items()}
    status = "pending" if quantity or any(usage.values()) else "recorded"
    db.execute("INSERT INTO work_logs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (token,day,item_id,workers,minutes,quantity,defective,note,json.dumps(recipe),json.dumps(usage),status,""))
    if status == "pending":
        return post_work(db, db.execute("SELECT * FROM work_logs WHERE id=?", (token,)).fetchone())
    return {"id":token,"status":status,"issue":""}


def cafe_data(db):
    return {"recipes": [dict(row) for row in db.execute("SELECT * FROM cafe_recipes ORDER BY menu_id,item_id")]}


def save_cafe(db, payload):
    menu = positive_int(payload.get("menu_id"), "판매 메뉴")
    if not db.execute("SELECT 1 FROM items WHERE id=? AND active=1", (menu,)).fetchone():
        raise ValueError("판매 메뉴를 다시 선택해 주세요.")
    components = payload.get("components")
    if not isinstance(components, list) or len(components) > 100:
        raise ValueError("재료 구성을 확인해 주세요.")
    rows = {}
    for entry in components:
        item_id = positive_int(entry.get("item_id"), "재료")
        stock_item(db, item_id)
        if item_id == menu or item_id in rows:
            raise ValueError("판매 메뉴 자신이나 동일 재료를 중복해서 넣을 수 없습니다.")
        if db.execute("SELECT 1 FROM inventory_policy WHERE item_id=? AND mode='snapshot'", (item_id,)).fetchone():
            raise ValueError("장부 추적 품목만 레시피 재료로 등록할 수 있습니다.")
        rows[item_id] = positive_int(entry.get("quantity"), "판매 1개당 사용량")
    db.execute("DELETE FROM cafe_recipes WHERE menu_id=?", (menu,))
    db.executemany("INSERT INTO cafe_recipes VALUES (?,?,?)", [(menu,i,q) for i,q in rows.items()])
    return {"ok": True}


def consume_cafe(db, sale_id, menu_id, quantity, day):
    parts = db.execute("""SELECT r.item_id,r.quantity,i.name,i.active,i.item_type
        FROM cafe_recipes r JOIN items i ON i.id=r.item_id WHERE menu_id=?""", (menu_id,)).fetchall()
    if not parts:
        return []
    menu = db.execute("SELECT name FROM items WHERE id=?", (menu_id,)).fetchone()[0]
    missing = []
    for part in parts:
        if not part["active"] or part["item_type"] != "STOCK":
            raise ValueError(f"카페 레시피의 {part['name']} 품목을 확인해 주세요.")
        ensure_open(db, part["item_id"], day)
        used = part["quantity"] * quantity
        if asof_stock(db, part["item_id"], day) < used:
            missing.append(part["name"])
        db.execute("""INSERT INTO transactions(transaction_date,transaction_type,item_id,quantity,unit_price,note,source)
            VALUES (?,'ADJUST_OUT',?,?,0,?,?)""", (day,part["item_id"],used,f"{menu} · 레시피 재료 사용",f"{CAFE_SOURCE}{sale_id}"))
    return missing


def record_waste(db, payload):
    item_id = positive_int(payload.get("item_id"), "폐기 품목")
    stock_item(db,item_id)
    quantity = positive_int(payload.get("quantity"), "폐기 수량")
    day = day_value(payload.get("date")).isoformat()
    note = text_field(payload)
    source = WASTE_SOURCE + ":" + request_token(payload.get("id"))
    if not db.execute("SELECT 1 FROM transactions WHERE source=?", (source,)).fetchone():
        ensure_open(db,item_id,day)
        db.execute("""INSERT INTO transactions(transaction_date,transaction_type,item_id,quantity,unit_price,note,source)
            VALUES (?,'ADJUST_OUT',?,?,0,?,?)""", (day,item_id,quantity,"폐기" + (f" · {note}" if note else ""),source))
    return {"ok": True, "stock":asof_stock(db,item_id,day)}


def update_order(db, payload):
    token = request_token(payload.get("id"))
    action = payload.get("action")
    if action == "add":
        item_id = positive_int(payload.get("item_id"), "발주 품목")
        stock_item(db,item_id)
        if db.execute("SELECT 1 FROM inventory_policy WHERE item_id=? AND mode='snapshot'", (item_id,)).fetchone():
            raise ValueError("장부 추적 품목만 발주를 등록할 수 있습니다.")
        day = day_value(payload.get("due_date"),allow_future=True)
        quantity = positive_int(payload.get("quantity"), "입고 예정 수량")
        db.execute("INSERT OR IGNORE INTO incoming_orders VALUES (?,?,?,?,?,'open',NULL)",
            (token,item_id,day.isoformat(),quantity,text_field(payload)))
        return {"ok": True}
    order = db.execute("SELECT * FROM incoming_orders WHERE id=?", (token,)).fetchone()
    if not order or action not in ("receive","cancel"):
        raise ValueError("발주 내역을 확인해 주세요.")
    if order["status"] != "open":
        if (action,order["status"]) in (("receive","received"),("cancel","cancelled")):
            return {"ok":True}
        raise ValueError("이미 처리된 발주입니다.")
    if action == "cancel":
        db.execute("UPDATE incoming_orders SET status='cancelled' WHERE id=?", (token,))
    else:
        stock_item(db,order["item_id"])
        day = day_value(payload.get("date")).isoformat()
        ensure_open(db,order["item_id"],day)
        price = whole(payload.get("unit_price"), "입고 단가")
        tx = db.execute("""INSERT INTO transactions(transaction_date,transaction_type,item_id,quantity,unit_price,note,source)
            VALUES (?,'PURCHASE',?,?,?,?,?)""", (day,order["item_id"],order["quantity"],price,order["note"],f"order:{token}"))
        db.execute("UPDATE incoming_orders SET status='received',received_tx=? WHERE id=?", (tx.lastrowid,token))
    return {"ok": True}


def buying_report(db):
    today = date.today()
    start = today - timedelta(days=27)
    orders = [dict(row) for row in db.execute("""SELECT o.*,i.name,i.unit FROM incoming_orders o
        JOIN items i ON i.id=o.item_id WHERE o.status='open' ORDER BY o.due_date,o.id""")]
    result = []
    for item in policy_rows(db):
        if item["mode"] != "ledger" or item["lead_days"] is None:
            continue
        item_id = item["id"]
        first = db.execute("SELECT MIN(transaction_date) FROM transactions WHERE item_id=? AND transaction_date<=?",
                           (item_id,today.isoformat())).fetchone()[0]
        movements = {r["transaction_date"]:r for r in db.execute(f"""SELECT transaction_date,
            SUM(CASE WHEN transaction_type IN {INBOUND} THEN quantity ELSE -quantity END) delta,
            SUM(CASE WHEN transaction_type IN ('SALE','ISSUE') OR
                (transaction_type='ADJUST_OUT' AND (source LIKE 'cafe:%' OR source LIKE 'waste:%'
                OR (source LIKE 'production:%' AND (note LIKE '% · 생산 재료 사용' OR note LIKE '% · 포장 개봉'))))
            THEN quantity ELSE 0 END) used
            FROM transactions WHERE item_id=? AND transaction_date BETWEEN ? AND ? GROUP BY transaction_date""",
            (item_id,start.isoformat(),today.isoformat()))}
        stock, days, used, skipped = 0, 0, 0, 0
        if first:
            observed_start = max(start,date.fromisoformat(first))
            stock = asof_stock(db,item_id,observed_start - timedelta(days=1))
            for offset in range((today - observed_start).days + 1):
                movement = movements.get((observed_start + timedelta(days=offset)).isoformat())
                demand = movement["used"] if movement else 0
                stock += movement["delta"] if movement else 0
                if stock <= 0 and not demand:
                    skipped += 1
                else:
                    days += 1
                    used += demand
        rate = Fraction(used,days) if days else Fraction(0)
        due = {}
        horizon = max(item["lead_days"], 60)
        for order in orders:
            if order["item_id"] != item_id:
                continue
            offset = (date.fromisoformat(order["due_date"]) - today).days
            if 0 <= offset <= horizon:
                due[offset] = due.get(offset,0) + order["quantity"]
        balance, peak_short, first_short, order_by, suggested = stock, 0, None, None, 0
        for offset in range(horizon + 1):
            balance += due.get(offset,0)
            if offset:
                balance -= rate
            if balance < 0:
                first_short = first_short or today + timedelta(days=offset)
                if offset <= item["lead_days"]:
                    peak_short = max(peak_short,-balance)
            if order_by is None and (balance < 0 or balance < item["min_stock"]):
                order_by = today + timedelta(days=max(0,offset-item["lead_days"]))
            if offset == item["lead_days"]:
                suggested = ceil(max(0,peak_short,item["min_stock"]-balance))
        result.append({**item,"stock":stock,"days":days,"skipped":skipped,"daily_usage":round(float(rate),2),
                       "incoming":sum(q for offset,q in due.items() if offset <= item["lead_days"]),
                       "short_date":first_short.isoformat() if first_short else None,
                       "order_by":order_by.isoformat() if order_by else None,"suggested":suggested})
    return {"items":sorted(result,key=lambda i:(i["order_by"] or "9999", -i["suggested"],i["id"])),"orders":orders}


def capacity_report(db, month):
    groups = {}
    for row in work_logs(db,month):
        groups.setdefault(row["item_id"],[]).append(row)
    results = []
    today = date.today().isoformat()
    for item_id, rows in groups.items():
        minutes = sum(row["person_minutes"] for row in rows)
        total = sum(row["quantity"] for row in rows)
        # Aggregate comparable rows into one observed rate per working date.
        days = {}
        for row in rows:
            observed = days.setdefault(row["work_date"],[0,0])
            observed[0] += row["quantity"]
            observed[1] += row["person_minutes"]
        typical = median(qty * 60 / time for qty,time in days.values())
        limits = []
        for part in db.execute("SELECT * FROM production_components WHERE finished_id=?", (item_id,)):
            try:
                stock_item(db,part["item_id"])
                loose = available_stock(db,part["item_id"],today)
                packed = 0
                if part["package_id"]:
                    stock_item(db,part["package_id"])
                    packed = available_stock(db,part["package_id"],today)
            except ValueError:
                limits.append(0)
                continue
            if min(loose,packed) < 0:
                limits.append(0)
            else:
                limits.append((loose + packed*(part["package_size"] or 0)) // part["quantity"])
        results.append({"item_id":item_id,"name":rows[0]["name"],"unit":rows[0]["unit"],"quantity":total,
            "defective":sum(row["defective"] for row in rows),"person_minutes":minutes,
            "days":len(days),"pending":sum(row["status"] == "pending" for row in rows),
            "hourly":round(total * 60 / minutes,2),"typical":typical,
            "material_limit":min(limits) if limits else None})
    return results
