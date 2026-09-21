
const $=s=>document.querySelector(s);
const parentView=$("#parentView"), adminView=$("#adminView");
let currentName="", currentStudent=null, pendingSlot=null, adminPin="", adminState=null;

function switchView(which){
  const parent=which==="parent";
  parentView.classList.toggle("hidden",!parent);
  adminView.classList.toggle("hidden",parent);
  history.replaceState(null,"",parent?"/":"/?admin=1");
}
if(new URLSearchParams(location.search).get("admin")==="1") switchView("admin");

async function api(path,body){
  const r=await fetch(path,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(body||{})
  });
  const j=await r.json().catch(()=>({error:"服务器返回异常"}));
  if(!r.ok) throw new Error(j.error||"操作失败");
  return j;
}
function toast(t){
  const el=$("#toast");
  el.textContent=t;
  el.classList.remove("hidden");
  setTimeout(()=>el.classList.add("hidden"),2300);
}
function esc(s){
  return String(s??"").replace(/[&<>"']/g,m=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[m]);
}
function fmtDate(d){
  const x=new Date(d+"T00:00:00");
  return `${x.getMonth()+1}月${x.getDate()}日`;
}
function casFull(k){
  return ({Joyce:"Joyce 吕怡潼",Willa:"Willa 姚肖敏",Emma:"Emma 马高霞",Layla:"Layla",Coco:"Coco 关晓玉"})[k]||k;
}
function cleanName(v){return String(v||"").trim();}

async function lookup(name){
  $("#lookupError").classList.add("hidden");
  const zhName=cleanName(name);
  if(!zhName){
    $("#lookupError").textContent="请输入学生中文姓名。";
    $("#lookupError").classList.remove("hidden");
    return;
  }
  try{
    const j=await api("/api/student/lookup",{zh_name:zhName});
    currentName=zhName;
    currentStudent=j.student;
    renderStudent();
  }catch(e){
    $("#lookupError").textContent=e.message;
    $("#lookupError").classList.remove("hidden");
  }
}
$("#lookupBtn").onclick=()=>lookup($("#studentChineseName").value);
$("#studentChineseName").addEventListener("keydown",e=>{
  if(e.key==="Enter") lookup($("#studentChineseName").value);
});
$("#switchStudent").onclick=()=>{
  currentName="";
  currentStudent=null;
  $("#studentPanel").classList.add("hidden");
  $("#lookupCard").classList.remove("hidden");
  $("#studentChineseName").value="";
  $("#studentChineseName").focus();
};
$("#refreshSlots").onclick=()=>lookup(currentName);

function renderStudent(){
  $("#lookupCard").classList.add("hidden");
  $("#studentPanel").classList.remove("hidden");
  $("#studentName").textContent=`${currentStudent.zh_name} · ${currentStudent.en_name||""}`;
  $("#studentMeta").innerHTML=
    `<span class="pill">${esc(currentStudent.class_name)}</span>`+
    `<span class="pill">班主任 ${esc(currentStudent.tutor)}</span>`+
    `<span class="pill">CAS ${esc(currentStudent.cas)}</span>`;

  const msg=$("#studentMessage"), conf=$("#bookingConfirmed"), sec=$("#slotsSection");
  msg.classList.add("hidden");
  conf.classList.add("hidden");
  sec.classList.add("hidden");

  if(currentStudent.booking){
    const b=currentStudent.booking;
    conf.innerHTML=
      `<div class="eyebrow">BOOKING CONFIRMED</div>
       <h2>预约已确认</h2>
       <div class="bookingline">${fmtDate(b.date)} ${esc(b.weekday||"")} · ${esc(b.start)}–${esc(b.end)}</div>
       <div>升导：${esc(currentStudent.cas)}　班主任：${esc(currentStudent.tutor)}</div>
       ${b.tutor_unavailable?'<div class="booking-warning">该时段班主任 Colin 无法参加，本次面谈将由学生与升导进行。</div>':""}
       <p class="muted">如需更改或取消预约，请联系班主任或学校 OP。</p>`;
    conf.classList.remove("hidden");
    return;
  }

  if(currentStudent.availability_state==="coco_separate"){
    msg.textContent="该学生对应 Coco 关晓玉，本轮面谈时间将另行安排，请留意学校通知。";
    msg.classList.remove("hidden");
    return;
  }
  if(currentStudent.availability_state==="not_in_round"){
    msg.textContent="该学生本轮暂未开放在线预约，请联系学校确认。";
    msg.classList.remove("hidden");
    return;
  }

  sec.classList.remove("hidden");
  renderSlots(currentStudent.slots||[]);
}

function renderSlots(slots){
  const el=$("#slotsList");
  el.innerHTML="";
  if(!slots.length){
    el.innerHTML='<div class="empty">目前暂无可预约时段，请稍后再次查看或联系学校工作人员。</div>';
    return;
  }
  const groups={};
  slots.forEach(s=>(groups[s.date]??=[]).push(s));
  Object.keys(groups).sort().forEach(date=>{
    const title=document.createElement("div");
    title.className="slotdate";
    title.textContent=`${fmtDate(date)} · ${groups[date][0].weekday||""}`;
    el.appendChild(title);

    const grid=document.createElement("div");
    grid.className="slots";
    groups[date].forEach(s=>{
      const b=document.createElement("button");
      b.className="slot";
      b.innerHTML=`<b>${esc(s.start)}–${esc(s.end)}</b><small>${esc(casFull(s.cas_key))}</small>${s.tutor_unavailable?'<span class="slot-warning">班主任无法参加</span>':""}`;
      b.onclick=()=>openModal(s);
      grid.appendChild(b);
    });
    el.appendChild(grid);
  });
}

function openModal(s){
  pendingSlot=s;
  $("#modalText").innerHTML=
    `${esc(currentStudent.zh_name)} · ${fmtDate(s.date)} ${esc(s.weekday||"")} ${esc(s.start)}–${esc(s.end)} · ${esc(currentStudent.cas)}`+
    (s.tutor_unavailable?'<div class="modal-warning">该时段 Colin 有教学课，班主任无法参加；学生仍可与升导进行面谈。</div>':"");
  $("#modal").classList.remove("hidden");
}
$("#cancelModal").onclick=()=>$("#modal").classList.add("hidden");
$("#confirmBooking").onclick=async()=>{
  if(!pendingSlot)return;
  try{
    const j=await api("/api/book",{zh_name:currentName,slot_key:pendingSlot.slot_key});
    currentStudent=j.student;
    $("#modal").classList.add("hidden");
    renderStudent();
    toast("预约成功");
  }catch(e){
    $("#modal").classList.add("hidden");
    alert(e.message);
    lookup(currentName);
  }
};

// 后台不在家长页展示入口；授权人员直接访问 /?admin=1
$("#adminBackBtn").onclick=()=>switchView("parent");
$("#adminLoginBtn").onclick=()=>adminLogin();
$("#adminPin").addEventListener("keydown",e=>{if(e.key==="Enter")adminLogin()});

async function adminLogin(){
  adminPin=$("#adminPin").value.trim();
  $("#adminError").classList.add("hidden");
  try{
    await loadAdmin();
    $("#adminLogin").classList.add("hidden");
    $("#adminPanel").classList.remove("hidden");
  }catch(e){
    $("#adminError").textContent=e.message;
    $("#adminError").classList.remove("hidden");
  }
}
async function loadAdmin(){
  const r=await fetch("/api/admin/state",{headers:{"X-Admin-Pin":adminPin}});
  const j=await r.json();
  if(!r.ok)throw new Error(j.error||"无法进入后台");
  adminState=j;
  renderAdmin();
}
async function exportCsv(){
  const teacher=$("#teacherExportFilter").value;
  const url="/api/admin/export.csv"+(teacher?"?teacher="+encodeURIComponent(teacher):"");
  const r=await fetch(url,{headers:{"X-Admin-Pin":adminPin}});
  if(!r.ok){
    const j=await r.json().catch(()=>({}));
    throw new Error(j.error||"导出失败");
  }
  const blob=await r.blob();
  const tmp=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=tmp;
  a.download=teacher?`IHS_bookings_${teacher}.csv`:"IHS_bookings_all.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(tmp);
}

function renderAdmin(){
  renderStats();
  renderStudentTable();
  renderSlotTable();
  renderBookings();
  renderEmmaBlocks();
}
function renderStats(){
  const s=adminState.stats;
  $("#stats").innerHTML=[
    ["本轮学生",s.in_round],
    ["已预约",s.booked],
    ["已发布时段",s.published],
    ["Coco另行安排",s.coco],
    ["G12学生",s.g12]
  ].map(x=>`<div class="stat"><span>${esc(x[0])}</span><b>${x[1]}</b></div>`).join("");
}
function studentStatus(s){
  const b=adminState.bookings.find(x=>x.student_id===s.id&&x.status==="active");
  if(b)return `<span class="status-green">已预约 ${esc(b.date)} ${esc(b.start)}</span>`;
  if(s.cas_key==="Coco")return '<span class="status-amber">另行安排</span>';
  return "<span>待预约</span>";
}
function renderStudentTable(){
  const q=($("#studentSearch").value||"").toLowerCase();
  const rows=adminState.students.filter(s=>
    `${s.zh_name} ${s.en_name} ${s.class_name} ${s.cas}`.toLowerCase().includes(q)
  );
  $("#studentTable").innerHTML=
    "<thead><tr><th>学生</th><th>班级</th><th>班主任</th><th>CAS</th><th>状态</th><th>查看</th></tr></thead><tbody>"+
    rows.map(s=>`<tr>
      <td><b>${esc(s.zh_name)}</b><br><span class="muted">${esc(s.en_name)}</span></td>
      <td>${esc(s.class_name)}</td>
      <td>${esc(s.tutor)}</td>
      <td>${esc(s.cas)}</td>
      <td>${studentStatus(s)}</td>
      <td><button class="ghost mini" onclick="previewStudent('${esc(s.zh_name)}')">家长端预览</button></td>
    </tr>`).join("")+
    "</tbody>";
}
$("#studentSearch").oninput=()=>renderStudentTable();
window.previewStudent=name=>{
  switchView("parent");
  $("#studentChineseName").value=name;
  lookup(name);
};

function blockAffectsSlot(s){
  const blocks=adminState.g12_blocks||[];
  return blocks.some(b=>{
    if(b.date!==s.date)return false;
    const overlaps=b.start < s.end && b.end > s.start;
    if(!overlaps)return false;
    if(b.person_key===s.cas_key)return true;
    return b.person_key==="Emma" && s.eligible_classes.includes("G11-1");
  });
}
function slotStatus(s){
  if(s.booked_student_id)return '<span class="status-green">已被预约</span>';
  if(blockAffectsSlot(s))return '<span class="status-red">G12时间冲突</span>';
  if(s.colin_unavailable)return '<span class="status-amber">Colin有课｜仍可预约</span>';
  if(Number(s.published)===1&&Number(s.g12_locked)===1)return '<span class="status-green">已发布</span>';
  if(Number(s.g12_locked)===1)return '<span class="status-amber">已锁定未发布</span>';
  return "<span>候选</span>";
}
function renderSlotTable(){
  const cas=$("#slotCasFilter").value, cls=$("#slotClassFilter").value;
  const rows=adminState.slots.filter(s=>
    (!cas||s.cas_key===cas)&&(!cls||(s.available_classes||s.eligible_classes||[]).includes(cls))
  );
  $("#slotTable").innerHTML=
    "<thead><tr><th>日期</th><th>时间</th><th>CAS</th><th>可参与班级</th><th>G12锁定</th><th>家长发布</th><th>状态</th><th>操作</th></tr></thead><tbody>"+
    rows.map(s=>`<tr>
      <td>${esc(s.date)}<br><span class="muted">${esc(s.weekday)}</span></td>
      <td>${esc(s.start)}–${esc(s.end)}</td>
      <td>${esc(s.cas_key)}</td>
      <td>${(s.available_classes||s.eligible_classes||[]).map(x=>`<span class="pill">${esc(x)}</span>`).join(" ")}</td>
      <td>${Number(s.g12_locked)===1?"✅":"—"}</td>
      <td>${Number(s.published)===1?"✅":"—"}</td>
      <td>${slotStatus(s)}</td>
      <td>${s.booked_student_id
        ?'<span class="muted">已有预约</span>'
        :Number(s.published)===1
          ?`<button class="ghost mini" onclick="slotAction('${esc(s.slot_key)}','unpublish')">取消发布</button> <button class="danger mini" onclick="slotAction('${esc(s.slot_key)}','unlock')">解锁</button>`
          :`<button class="primary mini" onclick="slotAction('${esc(s.slot_key)}','lock_publish')">锁定并发布</button>`
      }</td>
    </tr>`).join("")+
    "</tbody>";
}
$("#slotCasFilter").onchange=renderSlotTable;
$("#slotClassFilter").onchange=renderSlotTable;
window.slotAction=async(k,a)=>{
  try{
    await api("/api/admin/slot",{pin:adminPin,slot_key:k,action:a});
    await loadAdmin();
    toast("已更新");
  }catch(e){alert(e.message)}
};

function renderBookings(){
  const rows=adminState.bookings;
  $("#bookingTable").innerHTML=
    "<thead><tr><th>学生</th><th>班级</th><th>班主任</th><th>CAS</th><th>面谈时间</th><th>状态</th><th>操作</th></tr></thead><tbody>"+
    (rows.length
      ?rows.map(b=>`<tr>
        <td>${esc(b.zh_name)}<br><span class="muted">${esc(b.en_name)}</span></td>
        <td>${esc(b.class_name)}</td>
        <td>${esc(b.tutor)}</td>
        <td>${esc(b.cas)}</td>
        <td>${esc(b.date)} ${esc(b.start)}–${esc(b.end)}</td>
        <td>${esc(b.status)}</td>
        <td>${b.status==="active"
          ?`<button class="danger mini" onclick="adminCancelBooking(${b.id},'${esc(b.zh_name)}')">取消预约</button>`
          :'<span class="muted">—</span>'
        }</td>
      </tr>`).join("")
      :'<tr><td colspan="7" class="muted">暂无预约记录</td></tr>')+
    "</tbody>";
}
window.adminCancelBooking=async(id,name)=>{
  if(!confirm(`确定取消 ${name} 的当前预约吗？取消后该时段会重新释放。`))return;
  try{
    await api("/api/admin/cancel-booking",{pin:adminPin,booking_id:id});
    await loadAdmin();
    toast("预约已取消");
  }catch(e){alert(e.message)}
};

function normalizeDate(v){
  const s=String(v||"").trim().replaceAll(".","/").replaceAll("-","/");
  const p=s.split("/").filter(Boolean);
  if(p.length===3){
    const y=p[0].length===4?Number(p[0]):2026;
    const m=Number(p[1]), d=Number(p[2]);
    return `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  }
  if(p.length===2){
    return `2026-${String(Number(p[0])).padStart(2,"0")}-${String(Number(p[1])).padStart(2,"0")}`;
  }
  return "";
}
function normalizeTime(v){
  const m=String(v||"").trim().match(/(\d{1,2}):(\d{2})/);
  return m?`${String(Number(m[1])).padStart(2,"0")}:${m[2]}`:"";
}
function parseEmmaBlocks(text){
  const lines=String(text||"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const blocks=[];
  const bad=[];
  lines.forEach((line,i)=>{
    let cols=line.split("\t");
    if(cols.length<3) cols=line.split(",").map(x=>x.trim());
    if(cols.length<3) cols=line.split(/\s{2,}/).map(x=>x.trim());
    const date=normalizeDate(cols[0]);
    const start=normalizeTime(cols[1]);
    const end=normalizeTime(cols[2]);
    const note=cols.slice(3).join(" ").trim();
    if(!date||!start||!end||start>=end) bad.push(i+1);
    else blocks.push({date,start,end,note});
  });
  if(bad.length) throw new Error("以下行无法识别："+bad.join("、")+"。请确保每行至少有 日期、开始、结束。");
  return blocks;
}
function renderEmmaBlocks(){
  const rows=(adminState.g12_blocks||[]).filter(x=>x.person_key==="Emma");
  $("#emmaBlocksSummary").textContent=rows.length
    ?`当前已记录 Emma 的 G12 占用时间 ${rows.length} 条；最近一次：${rows[0].date} ${rows[0].start}–${rows[0].end}`
    :"当前尚未录入 Emma 的 G12 占用时间。";
}
$("#replaceEmmaBlocks").onclick=async()=>{
  try{
    const blocks=parseEmmaBlocks($("#emmaG12Paste").value);
    if(!confirm(`将用这 ${blocks.length} 条记录覆盖 Emma 当前的 G12 占用时间，继续吗？`))return;
    await api("/api/admin/g12-blocks/replace",{pin:adminPin,person_key:"Emma",blocks});
    $("#emmaG12Paste").value="";
    await loadAdmin();
    toast("Emma G12 占用时间已更新");
  }catch(e){alert(e.message)}
};

$("#refreshAdmin").onclick=()=>loadAdmin().catch(e=>alert(e.message));

$("#publishAllSlots").onclick=async()=>{
  if(!confirm("确定一键锁定并发布全部未过期、未被预约的候选时段吗？\n\n已录入的 G12 冲突仍会在家长端自动隐藏。"))return;
  try{
    const j=await api("/api/admin/publish-all",{pin:adminPin});
    await loadAdmin();
    toast(`已锁定并发布 ${j.published} 个时段`);
  }catch(e){
    alert(e.message);
  }
};

$("#exportCsv").onclick=async(e)=>{
  e.preventDefault();
  try{await exportCsv()}catch(err){alert(err.message)}
};
