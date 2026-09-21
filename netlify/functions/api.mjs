import postgres from "postgres";
import { getConnectionString } from "@netlify/database";
import seed from "./seed.js";

let sqlClient;
let schemaReady=false;

function db(){
  if(!sqlClient){
    sqlClient=postgres(getConnectionString(),{
      max:5,
      idle_timeout:20,
      connect_timeout:10,
      prepare:false
    });
  }
  return sqlClient;
}

function json(data,status=200,extraHeaders={}){
  return new Response(JSON.stringify(data),{
    status,
    headers:{
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store",
      ...extraHeaders
    }
  });
}

function adminPinOK(req,body={}){
  const pin=(req.headers.get("x-admin-pin")||body.pin||"").trim();
  const expected=(process.env.IHS_ADMIN_PIN||process.env.IHS_TEST_ADMIN_PIN||"").trim();
  return Boolean(expected)&&pin===expected;
}

function shanghaiNow(){
  const parts=new Intl.DateTimeFormat("en-CA",{
    timeZone:"Asia/Shanghai",
    year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",second:"2-digit",
    hourCycle:"h23"
  }).formatToParts(new Date());
  const get=t=>parts.find(p=>p.type===t)?.value||"";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}
function isPast(date,start){return `${date} ${start}:00`<=shanghaiNow();}
function cleanName(v){return String(v||"").trim();}
function overlaps(aStart,aEnd,bStart,bEnd){return aStart<bEnd&&aEnd>bStart;}

async function ensureSchema(){
  if(schemaReady)return;
  const sql=db();
  await sql`
    CREATE TABLE IF NOT EXISTS g12_blocks(
      id BIGSERIAL PRIMARY KEY,
      person_key TEXT NOT NULL,
      date TEXT NOT NULL,
      start TEXT NOT NULL,
      "end" TEXT NOT NULL,
      note TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS g12_blocks_person_date_idx
    ON g12_blocks(person_key,date)
  `;
  schemaReady=true;
}

async function ensureSeeded(){
  await ensureSchema();
  const sql=db();
  await sql.begin(async tx=>{
    await tx`SELECT pg_advisory_xact_lock(917260921)`;
    const rows=await tx`SELECT COUNT(*)::int AS count FROM students`;
    if(rows[0].count>0)return;

    for(const s of seed.students){
      await tx`
        INSERT INTO students
          (id,zh_name,en_name,class_name,tutor,cas,cas_key,round_status,token)
        VALUES
          (${s.id},${s.zh_name},${s.en_name||""},${s.class_name},${s.tutor},
           ${s.cas},${s.cas_key},${s.round_status},${s.token})
        ON CONFLICT (id) DO NOTHING
      `;
    }
    for(const sl of seed.slots){
      await tx`
        INSERT INTO slots
          (slot_key,cas_key,date,start,"end",weekday,eligible_classes,source_status,source_reason)
        VALUES
          (${sl.slot_key},${sl.cas_key},${sl.date},${sl.start},${sl.end},
           ${sl.weekday||""},${tx.json(sl.eligible_classes||[])},
           ${sl.source_status||""},${sl.source_reason||""})
        ON CONFLICT (slot_key) DO NOTHING
      `;
    }
  });
}

async function findStudentByName(sql,zhName){
  const name=cleanName(zhName);
  if(!name)throw new Error("请输入学生中文姓名。");
  const rows=await sql`SELECT * FROM students WHERE zh_name=${name} ORDER BY id`;
  if(rows.length===0)throw new Error("未找到该学生，请确认输入的是学生在校登记的中文姓名。");
  if(rows.length>1)throw new Error("存在同名学生，请联系学校工作人员协助预约。");
  return rows[0];
}

async function blockedForStudent(sql,student,date,start,end){
  const people=[student.cas_key];
  if(student.class_name==="G11-1"&&!people.includes("Emma"))people.push("Emma");
  const rows=await sql`
    SELECT * FROM g12_blocks
    WHERE date=${date}
      AND person_key=ANY(${people})
  `;
  return rows.some(b=>overlaps(start,end,b.start,b.end));
}

async function getStudentPayload(sql,student){
  const active=await sql`
    SELECT b.id,b.slot_key,b.created_at,sl.date,sl.start,sl."end",sl.weekday,sl.cas_key
    FROM bookings b
    JOIN slots sl ON sl.slot_key=b.slot_key
    WHERE b.student_id=${student.id} AND b.status='active'
    LIMIT 1
  `;

  const out={
    id:student.id,
    zh_name:student.zh_name,
    en_name:student.en_name,
    class_name:student.class_name,
    tutor:student.tutor,
    cas:student.cas,
    cas_key:student.cas_key,
    round_status:student.round_status,
    booking:active[0]?{...active[0],end:active[0].end}:null
  };

  if(student.cas_key==="Coco"){
    out.availability_state="coco_separate";out.slots=[];return out;
  }
  if(student.class_name==="G11-3"){
    out.availability_state="tutor_pending";out.slots=[];return out;
  }
  if(student.round_status!=="纳入本轮"){
    out.availability_state="not_in_round";out.slots=[];return out;
  }

  const rows=await sql`
    SELECT slot_key,cas_key,date,start,"end",weekday,eligible_classes
    FROM slots
    WHERE cas_key=${student.cas_key}
      AND published=1
      AND g12_locked=1
      AND booked_student_id IS NULL
    ORDER BY date,start
  `;

  const slots=[];
  for(const r of rows){
    if(!Array.isArray(r.eligible_classes)||!r.eligible_classes.includes(student.class_name))continue;
    if(isPast(r.date,r.start))continue;
    if(await blockedForStudent(sql,student,r.date,r.start,r.end))continue;
    slots.push({
      slot_key:r.slot_key,date:r.date,start:r.start,end:r.end,
      weekday:r.weekday,cas_key:r.cas_key
    });
  }
  out.availability_state="ready";
  out.slots=slots;
  return out;
}

function csvEscape(v){
  const s=String(v??"");
  return /[",\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s;
}

async function handle(req){
  if(!process.env.IHS_ADMIN_PIN&&!process.env.IHS_TEST_ADMIN_PIN){
    return json({error:"Netlify 尚未设置 IHS_ADMIN_PIN 环境变量"},500);
  }

  await ensureSeeded();
  const sql=db();
  const url=new URL(req.url);
  const path=url.pathname;

  if(path==="/api/health"){
    return json({ok:true,mode:"netlify-production",time:shanghaiNow()});
  }

  if(path==="/api/student/lookup"&&req.method==="POST"){
    const body=await req.json().catch(()=>({}));
    try{
      const student=await findStudentByName(sql,body.zh_name);
      return json({student:await getStudentPayload(sql,student)});
    }catch(e){
      return json({error:e.message},404);
    }
  }

  if(path==="/api/book"&&req.method==="POST"){
    const body=await req.json().catch(()=>({}));
    const slotKey=String(body.slot_key||"");
    try{
      const result=await sql.begin(async tx=>{
        const s=await findStudentByName(tx,body.zh_name);
        if(s.cas_key==="Coco")throw new Error("该学生本轮面谈另行安排。");
        if(s.class_name==="G11-3")throw new Error("该班面谈时间尚未开放。");

        const old=await tx`
          SELECT id FROM bookings
          WHERE student_id=${s.id} AND status='active'
          LIMIT 1
        `;
        if(old[0])throw new Error("该学生已经有一个有效预约。如需更改，请联系学校工作人员。");

        const slots=await tx`SELECT * FROM slots WHERE slot_key=${slotKey} LIMIT 1`;
        const sl=slots[0];
        if(!sl)throw new Error("时段不存在");
        if(sl.cas_key!==s.cas_key)throw new Error("该时段不属于学生对应升导");
        if(!Array.isArray(sl.eligible_classes)||!sl.eligible_classes.includes(s.class_name)){
          throw new Error("班主任无法参加该时段");
        }
        if(!sl.published||!sl.g12_locked)throw new Error("该时段尚未开放");
        if(isPast(sl.date,sl.start))throw new Error("该时段已经开始或已过期");
        if(await blockedForStudent(tx,s,sl.date,sl.start,sl.end)){
          throw new Error("该时段已被其他面谈安排占用，请选择其他时间。");
        }

        const claimed=await tx`
          UPDATE slots
          SET booked_student_id=${s.id}
          WHERE slot_key=${slotKey}
            AND booked_student_id IS NULL
          RETURNING slot_key
        `;
        if(!claimed[0])throw new Error("该时段刚刚已被其他家长预约，请选择其他时间。");

        await tx`
          INSERT INTO bookings(student_id,slot_key,status,created_at)
          VALUES(${s.id},${slotKey},'active',${shanghaiNow()})
        `;

        const fresh=(await tx`SELECT * FROM students WHERE id=${s.id}`)[0];
        return getStudentPayload(tx,fresh);
      });
      return json({ok:true,student:await result});
    }catch(e){
      return json({error:e.message||"预约失败"},409);
    }
  }

  if(path==="/api/admin/state"&&req.method==="GET"){
    if(!adminPinOK(req))return json({error:"管理员密码不正确"},403);

    const students=await sql`SELECT * FROM students ORDER BY class_name,id`;
    const slotsRaw=await sql`SELECT * FROM slots ORDER BY date,start,cas_key`;
    const g12Blocks=await sql`SELECT * FROM g12_blocks ORDER BY date DESC,start DESC`;
    const bookings=await sql`
      SELECT b.*,s.zh_name,s.en_name,s.class_name,s.tutor,s.cas,s.cas_key,
             sl.date,sl.start,sl."end"
      FROM bookings b
      JOIN students s ON s.id=b.student_id
      JOIN slots sl ON sl.slot_key=b.slot_key
      ORDER BY b.created_at DESC
    `;

    const slots=slotsRaw.map(r=>({...r,end:r.end}));
    const stats={
      students_total:students.length,
      in_round:students.filter(s=>s.round_status==="纳入本轮").length,
      coco:students.filter(s=>s.cas_key==="Coco").length,
      g11_3:students.filter(s=>s.class_name==="G11-3"&&s.round_status==="纳入本轮").length,
      published:slots.filter(s=>Number(s.published)===1).length,
      booked:bookings.filter(b=>b.status==="active").length
    };
    return json({
      students,slots,g12_blocks:g12Blocks,
      bookings:bookings.map(b=>({...b,end:b.end})),stats
    });
  }

  if(path==="/api/admin/export.csv"&&req.method==="GET"){
    if(!adminPinOK(req))return json({error:"管理员密码不正确"},403);
    const teacher=(url.searchParams.get("teacher")||"").trim();
    const pattern=teacher?`%${teacher}%`:"";

    const rows=teacher
      ?await sql`
        SELECT s.zh_name,s.en_name,s.class_name,s.tutor,s.cas,s.cas_key,
               sl.date,sl.start,sl."end",b.created_at
        FROM bookings b
        JOIN students s ON s.id=b.student_id
        JOIN slots sl ON sl.slot_key=b.slot_key
        WHERE b.status='active'
          AND (s.cas_key=${teacher} OR s.tutor ILIKE ${pattern})
        ORDER BY sl.date,sl.start
      `
      :await sql`
        SELECT s.zh_name,s.en_name,s.class_name,s.tutor,s.cas,s.cas_key,
               sl.date,sl.start,sl."end",b.created_at
        FROM bookings b
        JOIN students s ON s.id=b.student_id
        JOIN slots sl ON sl.slot_key=b.slot_key
        WHERE b.status='active'
        ORDER BY sl.date,sl.start
      `;

    const header=["中文姓名","English Name","班级","班主任","升导","日期","开始","结束","预约提交时间"];
    const lines=[header,...rows.map(r=>[
      r.zh_name,r.en_name,r.class_name,r.tutor,r.cas,
      r.date,r.start,r.end,r.created_at
    ])].map(row=>row.map(csvEscape).join(","));

    return new Response("\uFEFF"+lines.join("\r\n"),{
      status:200,
      headers:{
        "content-type":"text/csv; charset=utf-8",
        "content-disposition":'attachment; filename="G11_bookings.csv"',
        "cache-control":"no-store"
      }
    });
  }

  if(path.startsWith("/api/admin/")&&req.method==="POST"){
    const body=await req.json().catch(()=>({}));
    if(!adminPinOK(req,body))return json({error:"管理员密码不正确"},403);

    if(path==="/api/admin/slot"){
      const key=String(body.slot_key||"");
      const action=String(body.action||"");
      const rows=await sql`SELECT * FROM slots WHERE slot_key=${key} LIMIT 1`;
      const sl=rows[0];
      if(!sl)return json({error:"时段不存在"},404);

      if(action==="lock_publish"){
        await sql`UPDATE slots SET g12_locked=1,published=1 WHERE slot_key=${key}`;
      }else if(action==="unpublish"){
        await sql`UPDATE slots SET published=0 WHERE slot_key=${key}`;
      }else if(action==="unlock"){
        if(sl.booked_student_id!==null)return json({error:"已有预约的时段不能解锁"},409);
        await sql`UPDATE slots SET g12_locked=0,published=0 WHERE slot_key=${key}`;
      }else{
        return json({error:"未知操作"},400);
      }
      return json({ok:true});
    }

    if(path==="/api/admin/cancel-booking"){
      const id=Number(body.booking_id);
      try{
        await sql.begin(async tx=>{
          const rows=await tx`SELECT * FROM bookings WHERE id=${id} AND status='active' LIMIT 1`;
          const b=rows[0];
          if(!b)throw new Error("未找到有效预约");
          await tx`
            UPDATE bookings SET status='cancelled',cancelled_at=${shanghaiNow()}
            WHERE id=${id}
          `;
          await tx`
            UPDATE slots SET booked_student_id=NULL
            WHERE slot_key=${b.slot_key} AND booked_student_id=${b.student_id}
          `;
        });
        return json({ok:true});
      }catch(e){
        return json({error:e.message},409);
      }
    }

    if(path==="/api/admin/g12-blocks/replace"){
      const personKey=String(body.person_key||"").trim();
      const blocks=Array.isArray(body.blocks)?body.blocks:[];
      if(!personKey)return json({error:"缺少老师"},400);

      for(const b of blocks){
        if(!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date||"")) ||
           !/^\d{2}:\d{2}$/.test(String(b.start||"")) ||
           !/^\d{2}:\d{2}$/.test(String(b.end||"")) ||
           b.start>=b.end){
          return json({error:"占用时间格式不正确"},400);
        }
      }

      await sql.begin(async tx=>{
        await tx`DELETE FROM g12_blocks WHERE person_key=${personKey}`;
        for(const b of blocks){
          await tx`
            INSERT INTO g12_blocks(person_key,date,start,"end",note,source,created_at)
            VALUES(${personKey},${b.date},${b.start},${b.end},${b.note||""},'WPS paste',${shanghaiNow()})
          `;
        }
      });
      return json({ok:true,count:blocks.length});
    }
  }

  return json({error:"Not found"},404);
}

export default async(req)=>{
  try{return await handle(req);}
  catch(e){
    console.error(e);
    return json({error:"服务器异常，请稍后重试。"},500);
  }
};

export const config={path:"/api/*"};
