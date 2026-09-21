#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RGSG IHS G11 Parent & CAS Meeting Booking - Internal Cloud Test
Standard-library only. Configured for Render HTTPS deployment.
This remains a TEST system and is not the final parent-facing production release.
"""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import sqlite3, json, csv, io, os, socket, threading, sys

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = ROOT / "data"
IS_RENDER = os.environ.get("RENDER", "").lower() == "true"
DB = Path(os.environ.get("IHS_DB_PATH", str(ROOT / "booking_test.db"))).expanduser()
if IS_RENDER and not os.environ.get("IHS_TEST_ADMIN_PIN"):
    raise RuntimeError("Render 部署必须设置 IHS_TEST_ADMIN_PIN 环境变量")
ADMIN_PIN = os.environ.get("IHS_TEST_ADMIN_PIN", "OP-TEST-2026")
HOST = os.environ.get("IHS_TEST_HOST", "0.0.0.0")
# Render 会自动注入 PORT（目前默认 10000）；本地仍可使用 IHS_TEST_PORT。
PORT = int(os.environ.get("PORT", os.environ.get("IHS_TEST_PORT", "8000")))
MODE = "cloud-internal-test" if IS_RENDER else "local-internal-test"

DB_LOCK = threading.Lock()

TZ = ZoneInfo("Asia/Shanghai")
def now_dt():
    return datetime.now(TZ).replace(tzinfo=None)
def now_local():
    return now_dt().strftime("%Y-%m-%d %H:%M:%S")

def connect():
    con = sqlite3.connect(DB, timeout=10, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA journal_mode=WAL")
    return con

def init_db():
    # 在 Render 上，IHS_DB_PATH 应指向持久磁盘（例如 /var/data/booking_test.db）。
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = connect()
    con.executescript("""
    CREATE TABLE IF NOT EXISTS students(
      id INTEGER PRIMARY KEY,
      zh_name TEXT NOT NULL,
      en_name TEXT,
      class_name TEXT NOT NULL,
      tutor TEXT NOT NULL,
      cas TEXT NOT NULL,
      cas_key TEXT NOT NULL,
      round_status TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS slots(
      slot_key TEXT PRIMARY KEY,
      cas_key TEXT NOT NULL,
      date TEXT NOT NULL,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      weekday TEXT,
      eligible_classes TEXT NOT NULL,
      g12_locked INTEGER NOT NULL DEFAULT 0,
      published INTEGER NOT NULL DEFAULT 0,
      booked_student_id INTEGER,
      source_status TEXT,
      source_reason TEXT,
      FOREIGN KEY(booked_student_id) REFERENCES students(id)
    );
    CREATE TABLE IF NOT EXISTS bookings(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      slot_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      cancelled_at TEXT,
      FOREIGN KEY(student_id) REFERENCES students(id),
      FOREIGN KEY(slot_key) REFERENCES slots(slot_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking_per_student
      ON bookings(student_id) WHERE status='active';
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking_per_slot
      ON bookings(slot_key) WHERE status='active';
    """)
    count = con.execute("SELECT COUNT(*) FROM students").fetchone()[0]
    if count == 0:
        seed=json.loads((DATA/"seed.json").read_text(encoding="utf-8"))
        con.execute("BEGIN")
        try:
            for s in seed["students"]:
                con.execute("""INSERT INTO students
                  (id,zh_name,en_name,class_name,tutor,cas,cas_key,round_status,token)
                  VALUES(?,?,?,?,?,?,?,?,?)""",
                  (s["id"],s["zh_name"],s.get("en_name") or "",s["class_name"],s["tutor"],
                   s["cas"],s["cas_key"],s["round_status"],s["token"]))
            for sl in seed["slots"]:
                con.execute("""INSERT INTO slots
                  (slot_key,cas_key,date,start,end,weekday,eligible_classes,source_status,source_reason)
                  VALUES(?,?,?,?,?,?,?,?,?)""",
                  (sl["slot_key"],sl["cas_key"],sl["date"],sl["start"],sl["end"],sl.get("weekday",""),
                   json.dumps(sl["eligible_classes"],ensure_ascii=False),
                   sl.get("source_status",""),sl.get("source_reason","")))
            con.execute("COMMIT")
        except Exception:
            con.execute("ROLLBACK")
            raise
    con.close()

def student_payload(con, s):
    booking = con.execute("""
      SELECT b.id,b.slot_key,b.created_at,sl.date,sl.start,sl.end,sl.weekday,sl.cas_key
      FROM bookings b JOIN slots sl ON sl.slot_key=b.slot_key
      WHERE b.student_id=? AND b.status='active'
    """,(s["id"],)).fetchone()
    out=dict(s)
    out["booking"]=dict(booking) if booking else None
    if s["cas_key"]=="Coco":
        out["availability_state"]="coco_separate"
        out["slots"]=[]
        return out
    if s["class_name"]=="G11-3":
        out["availability_state"]="tutor_pending"
        out["slots"]=[]
        return out
    if s["round_status"]!="纳入本轮":
        out["availability_state"]="not_in_round"
        out["slots"]=[]
        return out
    rows=con.execute("""
      SELECT * FROM slots
      WHERE cas_key=? AND published=1 AND g12_locked=1 AND booked_student_id IS NULL
      ORDER BY date,start
    """,(s["cas_key"],)).fetchall()
    slots=[]
    now=now_dt()
    for r in rows:
        classes=json.loads(r["eligible_classes"])
        if s["class_name"] not in classes:
            continue
        try:
            starts=datetime.strptime(r["date"]+" "+r["start"],"%Y-%m-%d %H:%M")
            if starts <= now:
                continue
        except Exception:
            pass
        slots.append({
          "slot_key":r["slot_key"],"date":r["date"],"start":r["start"],"end":r["end"],
          "weekday":r["weekday"],"cas_key":r["cas_key"]
        })
    out["availability_state"]="ready"
    out["slots"]=slots
    return out

def check_pin(pin):
    return pin == ADMIN_PIN

def send_json(h, obj, status=200):
    data=json.dumps(obj,ensure_ascii=False).encode("utf-8")
    h.send_response(status)
    h.send_header("Content-Type","application/json; charset=utf-8")
    h.send_header("Content-Length",str(len(data)))
    h.send_header("Cache-Control","no-store")
    h.end_headers()
    h.wfile.write(data)

def get_body(h):
    n=int(h.headers.get("Content-Length","0") or 0)
    raw=h.rfile.read(n) if n else b"{}"
    try: return json.loads(raw.decode("utf-8"))
    except Exception: return {}

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # 基础浏览器安全响应头；Render 在外层负责 HTTPS/TLS。
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        super().end_headers()

    def translate_path(self,path):
        parsed=urlparse(path).path
        if parsed=="/": parsed="/index.html"
        return str(STATIC / parsed.lstrip("/"))

    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\n" % (now_local(), fmt%args))

    def do_GET(self):
        parsed=urlparse(self.path)
        if parsed.path=="/api/health":
            return send_json(self,{"ok":True,"time":now_local(),"mode":MODE})
        if parsed.path=="/api/admin/state":
            # 云端版不把管理员 PIN 放在 URL / 浏览器历史里。
            pin=(self.headers.get("X-Admin-Pin") or "").strip()
            if not pin and not IS_RENDER:
                q=parse_qs(parsed.query)
                pin=(q.get("pin") or [""])[0]
            if not check_pin(pin): return send_json(self,{"error":"管理员测试码不正确"},403)
            con=connect()
            students=[dict(r) for r in con.execute("SELECT * FROM students ORDER BY class_name,id")]
            slots=[]
            for r in con.execute("SELECT * FROM slots ORDER BY date,start,cas_key"):
                d=dict(r); d["eligible_classes"]=json.loads(d["eligible_classes"]); slots.append(d)
            bookings=[dict(r) for r in con.execute("""
              SELECT b.*,s.zh_name,s.en_name,s.class_name,s.cas_key,
                     sl.date,sl.start,sl.end
              FROM bookings b JOIN students s ON s.id=b.student_id
              JOIN slots sl ON sl.slot_key=b.slot_key
              ORDER BY b.created_at DESC
            """)]
            con.close()
            stats={
              "students_total":len(students),
              "in_round":sum(1 for s in students if s["round_status"]=="纳入本轮"),
              "coco":sum(1 for s in students if s["cas_key"]=="Coco"),
              "g11_3":sum(1 for s in students if s["class_name"]=="G11-3" and s["round_status"]=="纳入本轮"),
              "published":sum(1 for x in slots if x["published"]),
              "booked":sum(1 for b in bookings if b["status"]=="active"),
            }
            return send_json(self,{"students":students,"slots":slots,"bookings":bookings,"stats":stats})
        if parsed.path=="/api/admin/export.csv":
            pin=(self.headers.get("X-Admin-Pin") or "").strip()
            if not pin and not IS_RENDER:
                q=parse_qs(parsed.query); pin=(q.get("pin") or [""])[0]
            if not check_pin(pin): return send_json(self,{"error":"管理员测试码不正确"},403)
            con=connect()
            rows=con.execute("""
              SELECT s.zh_name,s.en_name,s.class_name,s.tutor,s.cas,
                     sl.date,sl.start,sl.end,b.created_at
              FROM bookings b JOIN students s ON s.id=b.student_id
              JOIN slots sl ON sl.slot_key=b.slot_key
              WHERE b.status='active' ORDER BY sl.date,sl.start
            """).fetchall()
            con.close()
            out=io.StringIO(); w=csv.writer(out)
            w.writerow(["中文姓名","English Name","班级","班主任","升导","日期","开始","结束","预约时间"])
            for r in rows: w.writerow(list(r))
            data=("\ufeff"+out.getvalue()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type","text/csv; charset=utf-8")
            self.send_header("Content-Disposition",'attachment; filename="G11_test_bookings.csv"')
            self.send_header("Content-Length",str(len(data))); self.end_headers(); self.wfile.write(data)
            return
        return super().do_GET()

    def do_POST(self):
        parsed=urlparse(self.path); body=get_body(self)
        if parsed.path=="/api/student/lookup":
            token=(body.get("token") or "").strip().upper()
            con=connect()
            s=con.execute("SELECT * FROM students WHERE UPPER(token)=?",(token,)).fetchone()
            if not s:
                con.close(); return send_json(self,{"error":"未找到该测试预约码，请核对后重试。"},404)
            payload=student_payload(con,s); con.close()
            return send_json(self,{"student":payload})

        if parsed.path=="/api/book":
            token=(body.get("token") or "").strip().upper()
            slot_key=body.get("slot_key") or ""
            with DB_LOCK:
                con=connect()
                try:
                    con.execute("BEGIN IMMEDIATE")
                    s=con.execute("SELECT * FROM students WHERE UPPER(token)=?",(token,)).fetchone()
                    if not s: raise ValueError("无效预约码")
                    if s["cas_key"]=="Coco": raise ValueError("Coco 学生本轮另行预约")
                    if s["class_name"]=="G11-3": raise ValueError("G11-3 班主任时间尚未导入，暂不开放")
                    old=con.execute("SELECT * FROM bookings WHERE student_id=? AND status='active'",(s["id"],)).fetchone()
                    if old: raise ValueError("该学生已经有一个有效预约，请先取消原预约")
                    sl=con.execute("SELECT * FROM slots WHERE slot_key=?",(slot_key,)).fetchone()
                    if not sl: raise ValueError("时段不存在")
                    if sl["cas_key"]!=s["cas_key"]: raise ValueError("该时段不属于学生对应升导")
                    if s["class_name"] not in json.loads(sl["eligible_classes"]): raise ValueError("班主任无法参加该时段")
                    if not sl["published"] or not sl["g12_locked"]: raise ValueError("该时段尚未正式发布")
                    if sl["booked_student_id"] is not None: raise ValueError("该时段刚刚已被其他家长预约，请选择其他时间")
                    starts=datetime.strptime(sl["date"]+" "+sl["start"],"%Y-%m-%d %H:%M")
                    if starts <= now_dt(): raise ValueError("该时段已经开始或已过期")
                    con.execute("UPDATE slots SET booked_student_id=? WHERE slot_key=? AND booked_student_id IS NULL",(s["id"],slot_key))
                    if con.total_changes < 1: raise ValueError("该时段刚刚已被其他家长预约")
                    con.execute("INSERT INTO bookings(student_id,slot_key,status,created_at) VALUES(?,?,?,?)",
                                (s["id"],slot_key,"active",now_local()))
                    con.execute("COMMIT")
                    s2=con.execute("SELECT * FROM students WHERE id=?",(s["id"],)).fetchone()
                    payload=student_payload(con,s2)
                    return send_json(self,{"ok":True,"student":payload})
                except Exception as e:
                    try: con.execute("ROLLBACK")
                    except Exception: pass
                    return send_json(self,{"error":str(e)},409)
                finally:
                    con.close()

        if parsed.path=="/api/cancel":
            token=(body.get("token") or "").strip().upper()
            with DB_LOCK:
                con=connect()
                try:
                    con.execute("BEGIN IMMEDIATE")
                    s=con.execute("SELECT * FROM students WHERE UPPER(token)=?",(token,)).fetchone()
                    if not s: raise ValueError("无效预约码")
                    b=con.execute("SELECT * FROM bookings WHERE student_id=? AND status='active'",(s["id"],)).fetchone()
                    if not b: raise ValueError("没有需要取消的预约")
                    con.execute("UPDATE bookings SET status='cancelled',cancelled_at=? WHERE id=?",(now_local(),b["id"]))
                    con.execute("UPDATE slots SET booked_student_id=NULL WHERE slot_key=? AND booked_student_id=?",(b["slot_key"],s["id"]))
                    con.execute("COMMIT")
                    s2=con.execute("SELECT * FROM students WHERE id=?",(s["id"],)).fetchone()
                    return send_json(self,{"ok":True,"student":student_payload(con,s2)})
                except Exception as e:
                    try: con.execute("ROLLBACK")
                    except Exception: pass
                    return send_json(self,{"error":str(e)},409)
                finally: con.close()

        if parsed.path.startswith("/api/admin/"):
            pin=(body.get("pin") or "").strip()
            if not check_pin(pin): return send_json(self,{"error":"管理员测试码不正确"},403)

            if parsed.path=="/api/admin/slot":
                key=body.get("slot_key") or ""; action=body.get("action") or ""
                con=connect()
                sl=con.execute("SELECT * FROM slots WHERE slot_key=?",(key,)).fetchone()
                if not sl: con.close(); return send_json(self,{"error":"时段不存在"},404)
                if action=="lock_publish":
                    con.execute("UPDATE slots SET g12_locked=1,published=1 WHERE slot_key=?",(key,))
                elif action=="unpublish":
                    con.execute("UPDATE slots SET published=0 WHERE slot_key=?",(key,))
                elif action=="unlock":
                    if sl["booked_student_id"] is not None:
                        con.close(); return send_json(self,{"error":"已有预约的时段不能解锁"},409)
                    con.execute("UPDATE slots SET g12_locked=0,published=0 WHERE slot_key=?",(key,))
                elif action=="publish":
                    if not sl["g12_locked"]:
                        con.close(); return send_json(self,{"error":"请先模拟从G12端锁定"},409)
                    con.execute("UPDATE slots SET published=1 WHERE slot_key=?",(key,))
                else:
                    con.close(); return send_json(self,{"error":"未知操作"},400)
                con.close(); return send_json(self,{"ok":True})

            if parsed.path=="/api/admin/sample-publish":
                con=connect()
                # Start clean for unbooked slots only.
                con.execute("UPDATE slots SET g12_locked=0,published=0 WHERE booked_student_id IS NULL")
                demands=con.execute("""
                  SELECT class_name,cas_key,COUNT(*) n FROM students
                  WHERE round_status='纳入本轮' AND cas_key<>'Coco' AND class_name IN ('G11-1','G11-2')
                  GROUP BY class_name,cas_key ORDER BY class_name,cas_key
                """).fetchall()
                selected=set()
                for d in demands:
                    need=min(2,d["n"])
                    eligible=[]
                    for r in con.execute("SELECT * FROM slots WHERE cas_key=? ORDER BY date,start",(d["cas_key"],)):
                        if d["class_name"] in json.loads(r["eligible_classes"]):
                            try:
                                if datetime.strptime(r["date"]+" "+r["start"],"%Y-%m-%d %H:%M") <= now_dt():
                                    continue
                            except Exception: pass
                            eligible.append(r["slot_key"])
                    have=sum(1 for k in selected if k in eligible)
                    for k in eligible:
                        if have>=need: break
                        if k not in selected:
                            selected.add(k); have+=1
                for k in selected:
                    con.execute("UPDATE slots SET g12_locked=1,published=1 WHERE slot_key=?",(k,))
                con.close()
                return send_json(self,{"ok":True,"published":len(selected)})

            if parsed.path=="/api/admin/reset":
                con=connect()
                con.execute("BEGIN")
                con.execute("DELETE FROM bookings")
                con.execute("UPDATE slots SET booked_student_id=NULL,g12_locked=0,published=0")
                con.execute("COMMIT"); con.close()
                return send_json(self,{"ok":True})

        return send_json(self,{"error":"Not found"},404)

def lan_ip():
    try:
        s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
        s.connect(("8.8.8.8",80)); ip=s.getsockname()[0]; s.close(); return ip
    except Exception:
        return "127.0.0.1"

if __name__=="__main__":
    init_db()
    ip=lan_ip()
    print("="*64)
    print("RGSG IHS G11 Booking - INTERNAL CLOUD TEST")
    if IS_RENDER:
        host=os.environ.get("RENDER_EXTERNAL_HOSTNAME", "Render service")
        print(f"云端服务: https://{host}" if host != "Render service" else "云端服务: Render")
        print(f"数据库: {DB}")
        print("管理员 PIN 已从环境变量读取（不会打印到日志）。")
    else:
        print(f"本机打开: http://127.0.0.1:{PORT}")
        print(f"同一网络测试: http://{ip}:{PORT}")
        print(f"管理员测试码: {ADMIN_PIN}")
    print("停止服务: Ctrl+C")
    print("注意：这是校内测试系统，不是正式家长生产环境。")
    print("="*64)
    ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()
