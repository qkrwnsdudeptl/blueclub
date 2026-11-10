import json
import re
from datetime import date


SOURCE_PREFIX = "production:"


def positive_int(value, label):
    if type(value) is not int or not 1 <= value <= 1_000_000_000:
        raise ValueError(f"{label}은(는) 1 이상의 정수로 입력해 주세요.")
    return value


def stock_item(db, item_id):
    item = db.execute("SELECT id, name, unit FROM items WHERE id=? AND active=1 AND item_type='STOCK'", (item_id,)).fetchone()
    if item is None:
        raise ValueError("사용 중인 재고품을 다시 선택해 주세요.")
    return dict(item)


def tracked_stock_item(db, item_id):
    item = stock_item(db, item_id)
    if db.execute("SELECT 1 FROM inventory_policy WHERE item_id=? AND mode='snapshot'", (item_id,)).fetchone():
        raise ValueError(f"{item['name']}은(는) 장부 추적 품목이어야 합니다.")
    return item


def save_recipe(db, payload):
    finished_id = positive_int(payload.get("finished_id"), "완성품")
    tracked_stock_item(db, finished_id)
    components = payload.get("components")
    if not isinstance(components, list) or not 1 <= len(components) <= 100:
        raise ValueError("재료를 1개 이상 선택해 주세요. 최대 100개입니다.")
    rows, materials, packages = [], set(), set()
    for component in components:
        if not isinstance(component, dict):
            raise ValueError("재료 구성을 확인해 주세요.")
        item_id = positive_int(component.get("item_id"), "재료")
        if item_id == finished_id or item_id in materials:
            raise ValueError("완성품을 재료로 넣거나 같은 재료를 중복 등록할 수 없습니다.")
        tracked_stock_item(db, item_id)
        materials.add(item_id)
        quantity = positive_int(component.get("quantity"), "완성품 1개당 재료 수량")
        package_id = component.get("package_id")
        package_size = None
        if package_id is not None:
            package_id = positive_int(package_id, "포장 품목")
            tracked_stock_item(db, package_id)
            if package_id == finished_id or package_id in packages:
                raise ValueError("완성품을 포장 품목으로 쓰거나 같은 포장 품목을 중복 등록할 수 없습니다.")
            packages.add(package_id)
            package_size = positive_int(component.get("package_size"), "포장 하나당 낱개 수량")
            existing = db.execute(
                """SELECT 1 FROM production_components
                   WHERE package_id=? AND finished_id<>? AND (item_id<>? OR package_size<>?)""",
                (package_id, finished_id, item_id, package_size),
            ).fetchone()
            if existing:
                raise ValueError("다른 생산 구성에서 이 포장 품목을 다른 낱개 품목 또는 수량으로 환산하고 있습니다.")
        rows.append((finished_id, item_id, quantity, package_id, package_size))
    if materials & packages:
        raise ValueError("같은 생산 구성에서 낱개 재료와 포장 품목은 서로 달라야 합니다.")
    db.execute("DELETE FROM production_components WHERE finished_id=?", (finished_id,))
    db.executemany(
        "INSERT INTO production_components(finished_id,item_id,quantity,package_id,package_size) VALUES (?,?,?,?,?)",
        rows,
    )


def list_production(db):
    recipes = {}
    for row in db.execute("SELECT * FROM production_components ORDER BY finished_id, item_id"):
        recipes.setdefault(row["finished_id"], []).append(dict(row))
    batches = [
        {**dict(row), "details": json.loads(row["details"])}
        for row in db.execute("SELECT * FROM production_batches ORDER BY produced_date DESC, rowid DESC LIMIT 100")
    ]
    return {"recipes": recipes, "batches": batches}


def available_stock(db, item_id, today):
    # A shipment already scheduled for a later date must remain possible.
    row = db.execute(
        """WITH daily AS (
               SELECT MAX(transaction_date, ?) AS day,
                      SUM(CASE WHEN transaction_type IN ('PURCHASE','RETURN_IN','ADJUST_IN')
                          THEN quantity ELSE -quantity END) AS delta
               FROM transactions WHERE item_id=? GROUP BY day
               UNION ALL SELECT ?, 0
           ), balances AS (
               SELECT SUM(delta) OVER (ORDER BY day) AS balance FROM daily
           )
           SELECT MIN(balance) FROM balances""", (today, item_id, today),
    ).fetchone()
    return row[0]


def record_production(db, payload, *, work_date=None, recipe=None, usage=None, check_open):
    finished_id = positive_int(payload.get("finished_id"), "완성품")
    quantity = payload["quantity"] if work_date is not None else positive_int(payload.get("quantity"), "생산 수량")
    batch_id = payload.get("request_id")
    if not isinstance(batch_id, str) or not re.fullmatch(r"[a-f0-9]{32}", batch_id):
        raise ValueError("생산 요청이 올바르지 않습니다. 화면을 새로고침해 주세요.")
    note = str(payload.get("note", "")).strip()
    if len(note) > 300:
        raise ValueError("비고는 300자까지 입력할 수 있습니다.")
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")
    existing = db.execute("SELECT * FROM production_batches WHERE id=?", (batch_id,)).fetchone()
    if existing:
        if (finished_id, quantity, note) != (existing["finished_id"], existing["quantity"], json.loads(existing["details"])["note"]):
            raise ValueError("이미 처리한 생산 요청입니다. 새로 입력해 주세요.")
        return batch_id
    finished = tracked_stock_item(db, finished_id)
    components = recipe if recipe is not None else db.execute(
        "SELECT * FROM production_components WHERE finished_id=? ORDER BY item_id", (finished_id,)
    ).fetchall()
    if not components:
        raise ValueError("완성품 1개에 필요한 재료를 먼저 등록해 주세요.")
    day = work_date or date.today().isoformat()
    overrides = usage or {}
    movements = []
    for component in components:
        needed = overrides.get(str(component["item_id"]), component["quantity"] * quantity)
        if not needed:
            continue
        item = tracked_stock_item(db, component["item_id"])
        loose = available_stock(db, item["id"], day)
        package = tracked_stock_item(db, component["package_id"]) if component["package_id"] is not None else None
        packed = available_stock(db, package["id"], day) if package else 0
        pack_size = component["package_size"] or 0
        if loose < 0 or packed < 0:
            raise ValueError(f"{item['name']}의 낱개 또는 포장 재고가 음수입니다. 재고를 확인해 주세요.")
        available = loose + packed * pack_size
        if needed > available:
            raise ValueError(f"{item['name']} {needed - available:,}{item['unit']} 부족 · 이 재료 기준 최대 {available // component['quantity']:,}개 생산 가능")
        if package and needed > loose:
            opened = (needed - loose + pack_size - 1) // pack_size
            movements.append({**package, "delta": -opened, "action": "포장 개봉"})
            movements.append({**item, "delta": opened * pack_size, "action": "개봉 낱개 입고"})
        movements.append({**item, "delta": -needed, "action": "생산 재료 사용"})
    if quantity:
        movements.append({**finished, "delta": quantity, "action": "완성품 입고"})
    for move in movements:
        check_open(move["id"], day)
    details = {"finished": finished, "movements": movements, "note": note}
    if quantity:
        db.execute(
            "INSERT INTO production_batches(id,produced_date,finished_id,quantity,details) VALUES (?,?,?,?,?)",
            (batch_id, day, finished_id, quantity, json.dumps(details, ensure_ascii=False)),
        )
    db.executemany(
        """INSERT INTO transactions(transaction_date,transaction_type,item_id,quantity,unit_price,note,source)
           VALUES (?,?,?,?,0,?,?)""",
        [(day, "ADJUST_IN" if move["delta"]>0 else "ADJUST_OUT", move["id"], abs(move["delta"]),
          f"{finished['name']} · {move['action']}", SOURCE_PREFIX + batch_id) for move in movements],
    )
    return batch_id
