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

function adminPinValue(){
  return (process.env.IHS_ADMIN_PIN||process.env.IHS_TEST_ADMIN_PIN||"").trim();
}

function adminPinConfigured(){
  return Boolean(adminPinValue());
}

function adminPinOK(req,body={}){
  const pin=(req.headers.get("x-admin-pin")||body.pin||"").trim();
  const expected=adminPinValue();
  return Boolean(expected)&&pin===expected;
}

function requireAdmin(req,body={}){
  if(!adminPinConfigured()){
    return json({error:"后台管理员密码尚未配置，请先在 Netlify 设置 IHS_ADMIN_PIN。"},503);
  }
  if(!adminPinOK(req,body)){
    return json({error:"管理员密码不正确"},403);
  }
  return null;
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

function dingtalkWebhook(){
  return (process.env.DINGTALK_BOOKING_WEBHOOK||"").trim();
}

async function sendDingTalkBookingNotification(student){
  const webhook=dingtalkWebhook();
  if(!webhook||!student?.booking)return {sent:false,reason:"not_configured"};

  const b=student.booking;
  const message=[
    "【新增升学面谈预约】",
    `学生：${student.zh_name}${student.en_name?" · "+student.en_name:""}`,
    `班级：${student.class_name}`,
    `CAS：${student.cas}`,
    `班主任：${student.tutor}`,
    `时间：${b.date} ${b.weekday||""} ${b.start}–${b.end}`,
    b.tutor_unavailable?"备注：该时段班主任无法参加":"状态：预约已确认"
  ].join("\n");

  const payload={
    event:"booking_created",
    title:"新增升学面谈预约",
    content:message,
    message,
    msgtype:"text",
    text:{content:message},
    student:{
      id:student.id,
      zh_name:student.zh_name,
      en_name:student.en_name,
      class_name:student.class_name,
      tutor:student.tutor,
      cas:student.cas,
      cas_key:student.cas_key
    },
    booking:{
      slot_key:b.slot_key,
      date:b.date,
      weekday:b.weekday||"",
      start:b.start,
      end:b.end
    }
  };

  try{
    const r=await fetch(webhook,{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify(payload)
    });
    const responseText=await r.text().catch(()=>"");
    if(!r.ok){
      console.error("DingTalk webhook failed",r.status,responseText.slice(0,500));
      return {sent:false,reason:"http_error",status:r.status};
    }
    return {sent:true,status:r.status};
  }catch(e){
    console.error("DingTalk webhook error",e);
    return {sent:false,reason:"network_error"};
  }
}

// G11-2 特殊规则：Colin 的课表不再阻止家长预约。
// 若面谈时间与 Colin 的教学课重叠，只在家长端标注“班主任无法参加”。
const COLIN_BUSY={
  "周一":[["13:25","14:50"],["15:00","16:20"]],
  "周二":[["08:15","09:40"],["15:00","16:20"]],
  "周三":[["11:30","12:10"]],
  "周四":[["15:00","16:20"]],
  "周五":[["11:30","12:10"],["13:25","14:50"]]
};
function colinUnavailable(weekday,start,end){
  return (COLIN_BUSY[weekday]||[]).some(([bs,be])=>overlaps(start,end,bs,be));
}

// G12 form tutor 固定课表（来自 2026-09-21 提供的课表）。
const G12_TUTOR_BUSY={
  "G12 1":{
    "周二":[["08:15","08:55"]],
    "周三":[["08:15","08:55"],["11:30","12:10"]],
    "周四":[["11:30","12:10"]],
    "周五":[["10:00","11:20"],["13:25","14:05"]]
  },
  "G12 2":{
    "周一":[["14:10","14:50"],["15:00","16:20"]],
    "周三":[["10:00","11:20"]],
    "周四":[["15:00","16:20"]],
    "周五":[["08:15","08:55"]]
  }
};
function g12TutorUnavailable(className,weekday,start,end){
  return (G12_TUTOR_BUSY[className]?.[weekday]||[])
    .some(([bs,be])=>overlaps(start,end,bs,be));
}

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
  await sql`
    CREATE TABLE IF NOT EXISTS tutor_availability(
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
    CREATE INDEX IF NOT EXISTS tutor_availability_person_date_idx
    ON tutor_availability(person_key,date)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS system_meta(
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  schemaReady=true;
}

async function ensureSeeded(){
  await ensureSchema();
  const sql=db();
  await sql.begin(async tx=>{
    await tx`SELECT pg_advisory_xact_lock(917260921)`;

    // 每次启动/请求都以 seed 中的最新名单同步学生基础资料。
    // 预约记录仍然按 student id 保留，不会因为名单同步而被删除。
    for(const s of seed.students){
      await tx`
        INSERT INTO students
          (id,zh_name,en_name,class_name,tutor,cas,cas_key,round_status,token)
        VALUES
          (${s.id},${s.zh_name},${s.en_name||""},${s.class_name},${s.tutor},
           ${s.cas},${s.cas_key},${s.round_status},${s.token})
        ON CONFLICT (id) DO UPDATE SET
          zh_name=EXCLUDED.zh_name,
          en_name=EXCLUDED.en_name,
          class_name=EXCLUDED.class_name,
          tutor=EXCLUDED.tutor,
          cas=EXCLUDED.cas,
          cas_key=EXCLUDED.cas_key,
          round_status=EXCLUDED.round_status,
          token=EXCLUDED.token
      `;
    }

    // 候选时段的基础信息同步，但保留后台已经设置的发布、锁定和预约状态。
    for(const sl of seed.slots){
      await tx`
        INSERT INTO slots
          (slot_key,cas_key,date,start,"end",weekday,eligible_classes,source_status,source_reason)
        VALUES
          (${sl.slot_key},${sl.cas_key},${sl.date},${sl.start},${sl.end},
           ${sl.weekday||""},${tx.json(sl.eligible_classes||[])},
           ${sl.source_status||""},${sl.source_reason||""})
        ON CONFLICT (slot_key) DO UPDATE SET
          cas_key=EXCLUDED.cas_key,
          date=EXCLUDED.date,
          start=EXCLUDED.start,
          "end"=EXCLUDED."end",
          weekday=EXCLUDED.weekday,
          eligible_classes=EXCLUDED.eligible_classes,
          source_status=EXCLUDED.source_status,
          source_reason=EXCLUDED.source_reason
      `;
    }

    // 一次性迁移旧预约表里已经确认的 G11 / G12 预约。
    // v2 包含用户提供的 Joyce / Emma / Willa 三张历史预约表。
    const migrationKey="legacy_existing_bookings_v2";
    const migrated=await tx`SELECT key FROM system_meta WHERE key=${migrationKey} LIMIT 1`;
    if(!migrated[0]&&Array.isArray(seed.initial_bookings)){
      for(const b of seed.initial_bookings){
        const students=await tx`SELECT id FROM students WHERE zh_name=${b.zh_name} LIMIT 1`;
        const slots=await tx`SELECT slot_key FROM slots WHERE slot_key=${b.slot_key} LIMIT 1`;
        if(!students[0]||!slots[0])continue;
        const studentId=students[0].id;

        const existing=await tx`
          SELECT id FROM bookings
          WHERE student_id=${studentId} AND status='active'
          LIMIT 1
        `;
        if(existing[0])continue;

        // 只有成功占到该 slot 才写入预约记录，避免旧记录覆盖线上新预约。
        const claimed=await tx`
          UPDATE slots
          SET booked_student_id=${studentId},
              g12_locked=1,
              published=1
          WHERE slot_key=${b.slot_key}
            AND booked_student_id IS NULL
          RETURNING slot_key
        `;
        if(!claimed[0])continue;

        await tx`
          INSERT INTO bookings(student_id,slot_key,status,created_at)
          VALUES(${studentId},${b.slot_key},'active',${b.created_at||shanghaiNow()})
          ON CONFLICT DO NOTHING
        `;
      }
      await tx`
        INSERT INTO system_meta(key,value,updated_at)
        VALUES(${migrationKey},'done',${shanghaiNow()})
        ON CONFLICT (key) DO NOTHING
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

async function tutorHasAvailability(sql,personKey){
  const rows=await sql`
    SELECT COUNT(*)::int AS count
    FROM tutor_availability
    WHERE person_key=${personKey}
  `;
  return rows[0].count>0;
}

async function tutorAvailable(sql,personKey,date,start,end){
  const rows=await sql`
    SELECT * FROM tutor_availability
    WHERE person_key=${personKey}
      AND date=${date}
  `;
  return rows.some(a=>a.start<=start&&a.end>=end);
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
    booking:active[0]?{
      ...active[0],
      end:active[0].end,
      tutor_unavailable:student.class_name==="G11-2"
        ?colinUnavailable(active[0].weekday,active[0].start,active[0].end)
        :false
    }:null
  };

  if(student.cas_key==="Coco"){
    out.availability_state="coco_separate";out.slots=[];return out;
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
    const classEligible=Array.isArray(r.eligible_classes)&&r.eligible_classes.includes(student.class_name);
    // G11-2：优先学生 + CAS；Colin 有课只提示。
    // G11-3：Ariel 默认全部时间可参加，因此只看学生对应 CAS 的可预约时间。
    // G12：只看 CAS 可用时段，同时必须避开对应班主任的固定教学/值班时间。
    const isG12=String(student.class_name||"").startsWith("G12 ");
    if(!["G11-2","G11-3"].includes(student.class_name)&&!isG12&&!classEligible)continue;
    if(isPast(r.date,r.start))continue;
    if(await blockedForStudent(sql,student,r.date,r.start,r.end))continue;
    if(isG12&&g12TutorUnavailable(student.class_name,r.weekday,r.start,r.end))continue;
    slots.push({
      slot_key:r.slot_key,date:r.date,start:r.start,end:r.end,
      weekday:r.weekday,cas_key:r.cas_key,
      tutor_unavailable:student.class_name==="G11-2"
        ?colinUnavailable(r.weekday,r.start,r.end)
        :false
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
  // 家长端查询与预约不依赖管理员密码。
  // IHS_ADMIN_PIN 只保护 /api/admin/* 后台接口。
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
        const classEligible=Array.isArray(sl.eligible_classes)&&sl.eligible_classes.includes(s.class_name);
        const isG12=String(s.class_name||"").startsWith("G12 ");
        if(!["G11-2","G11-3"].includes(s.class_name)&&!isG12&&!classEligible){
          throw new Error("班主任无法参加该时段");
        }
        if(isG12&&g12TutorUnavailable(s.class_name,sl.weekday,sl.start,sl.end)){
          throw new Error("该时段班主任有课，请选择其他时间。");
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
      const bookedStudent=await result;
      const notify=await sendDingTalkBookingNotification(bookedStudent);
      return json({ok:true,student:bookedStudent,notification:notify});
    }catch(e){
      return json({error:e.message||"预约失败"},409);
    }
  }

  if(path==="/api/admin/state"&&req.method==="GET"){
    const denied=requireAdmin(req);
    if(denied)return denied;

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

    const slots=slotsRaw.map(r=>{
      const availableClasses=[];
      if(Array.isArray(r.eligible_classes)&&r.eligible_classes.includes("G11-1"))availableClasses.push("G11-1");
      // G11-2 / G11-3 现在都以 CAS 时间优先。
      availableClasses.push("G11-2","G11-3");
      if(!g12TutorUnavailable("G12 1",r.weekday,r.start,r.end))availableClasses.push("G12 1");
      if(!g12TutorUnavailable("G12 2",r.weekday,r.start,r.end))availableClasses.push("G12 2");
      return {
        ...r,
        end:r.end,
        available_classes:[...new Set(availableClasses)],
        colin_unavailable:colinUnavailable(r.weekday,r.start,r.end),
        g12_1_tutor_unavailable:g12TutorUnavailable("G12 1",r.weekday,r.start,r.end),
        g12_2_tutor_unavailable:g12TutorUnavailable("G12 2",r.weekday,r.start,r.end)
      };
    });
    const stats={
      students_total:students.length,
      in_round:students.filter(s=>s.round_status==="纳入本轮").length,
      coco:students.filter(s=>s.cas_key==="Coco").length,
      g11_3:students.filter(s=>s.class_name==="G11-3"&&s.round_status==="纳入本轮").length,
      g12:students.filter(s=>String(s.class_name||"").startsWith("G12 ")&&s.round_status==="纳入本轮").length,
      published:slots.filter(s=>Number(s.published)===1).length,
      booked:bookings.filter(b=>b.status==="active").length
    };
    return json({
      students,slots,g12_blocks:g12Blocks,
      bookings:bookings.map(b=>({...b,end:b.end})),stats
    });
  }

  if(path==="/api/admin/export.csv"&&req.method==="GET"){
    const denied=requireAdmin(req);
    if(denied)return denied;
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

    const header=["中文姓名","English Name","班级","班主任","升导","日期","开始","结束","班主任参与情况","预约提交时间"];
    const lines=[header,...rows.map(r=>[
      r.zh_name,r.en_name,r.class_name,r.tutor,r.cas,
      r.date,r.start,r.end,
      r.class_name==="G11-2"&&colinUnavailable(
        (new Intl.DateTimeFormat("zh-CN",{weekday:"short",timeZone:"Asia/Shanghai"}).format(new Date(r.date+"T00:00:00+08:00"))).replace("星期","周"),
        r.start,r.end
      )?"班主任无法参加":"班主任可参加",
      r.created_at
    ])].map(row=>row.map(csvEscape).join(","));

    return new Response("\uFEFF"+lines.join("\r\n"),{
      status:200,
      headers:{
        "content-type":"text/csv; charset=utf-8",
        "content-disposition":'attachment; filename="IHS_parent_interview_bookings.csv"',
        "cache-control":"no-store"
      }
    });
  }

  if(path.startsWith("/api/admin/")&&req.method==="POST"){
    const body=await req.json().catch(()=>({}));
    const denied=requireAdmin(req,body);
    if(denied)return denied;

    if(path==="/api/admin/test-dingtalk"){
      if(!dingtalkWebhook())return json({error:"尚未配置 DINGTALK_BOOKING_WEBHOOK 环境变量。"},503);
      const testStudent={
        id:"test",
        zh_name:"测试学生",
        en_name:"Test Student",
        class_name:"G11-TEST",
        tutor:"Test Form Tutor",
        cas:"Test CAS",
        cas_key:"Test",
        booking:{
          slot_key:"TEST",
          date:new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()),
          weekday:"测试",
          start:"00:00",
          end:"00:30"
        }
      };
      const result=await sendDingTalkBookingNotification(testStudent);
      if(!result.sent)return json({error:"钉钉 Webhook 调用失败，请检查连接器配置。",detail:result},502);
      return json({ok:true,result});
    }

    if(path==="/api/admin/publish-all"){
      const rows=await sql`
        SELECT slot_key,date,start,booked_student_id
        FROM slots
        ORDER BY date,start
      `;

      const eligible=rows.filter(r=>
        r.booked_student_id===null &&
        !isPast(r.date,r.start)
      );

      await sql.begin(async tx=>{
        for(const r of eligible){
          await tx`
            UPDATE slots
            SET g12_locked=1,published=1
            WHERE slot_key=${r.slot_key}
              AND booked_student_id IS NULL
          `;
        }
      });

      return json({ok:true,published:eligible.length});
    }

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
