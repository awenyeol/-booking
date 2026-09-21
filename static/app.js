
const $=s=>document.querySelector(s);
const parentTab=$("#parentTab"), adminTab=$("#adminTab"), parentView=$("#parentView"), adminView=$("#adminView");
let currentToken="", currentStudent=null, pendingSlot=null, adminPin="", adminState=null;

function switchView(which){
  const p=which==="parent";
  parentView.classList.toggle("hidden",!p); adminView.classList.toggle("hidden",p);
  parentTab.classList.toggle("active",p); adminTab.classList.toggle("active",!p);
  history.replaceState(null,"",p?"/":"/?admin=1");
}
parentTab.onclick=()=>switchView("parent"); adminTab.onclick=()=>switchView("admin");
if(new URLSearchParams(location.search).get("admin")==="1") switchView("admin");

async function api(path,body){
  const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})});
  const j=await r.json().catch(()=>({error:"服务器返回异常"}));
  if(!r.ok) throw new Error(j.error||"操作失败");
  return j;
}
function toast(t){const el=$("#toast");el.textContent=t;el.classList.remove("hidden");setTimeout(()=>el.classList.add("hidden"),2300)}
function esc(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]))}
function fmtDate(d){const x=new Date(d+"T00:00:00");return `${x.getMonth()+1}月${x.getDate()}日`}
function casFull(k){return ({Joyce:"Joyce 吕怡潼",Willa:"Willa 姚肖敏",Emma:"Emma 马高霞",Layla:"Layla",Coco:"Coco 关晓玉"})[k]||k}

async function lookup(token){
  $("#lookupError").classList.add("hidden");
  try{
    const j=await api("/api/student/lookup",{token});
    currentToken=token.trim().toUpperCase(); currentStudent=j.student; renderStudent();
  }catch(e){$("#lookupError").textContent=e.message;$("#lookupError").classList.remove("hidden")}
}
$("#lookupBtn").onclick=()=>lookup($("#bookingCode").value);
$("#bookingCode").addEventListener("keydown",e=>{if(e.key==="Enter") lookup($("#bookingCode").value)});
$("#switchStudent").onclick=()=>{currentToken="";currentStudent=null;$("#studentPanel").classList.add("hidden");$("#lookupCard").classList.remove("hidden");$("#bookingCode").value="";};
$("#refreshSlots").onclick=()=>lookup(currentToken);

function renderStudent(){
  $("#lookupCard").classList.add("hidden"); $("#studentPanel").classList.remove("hidden");
  $("#studentName").textContent=`${currentStudent.zh_name} · ${currentStudent.en_name||""}`;
  $("#studentMeta").innerHTML=`<span class="pill">${esc(currentStudent.class_name)}</span><span class="pill">班主任 ${esc(currentStudent.tutor)}</span><span class="pill">CAS ${esc(currentStudent.cas)}</span>`;
  const msg=$("#studentMessage"), conf=$("#bookingConfirmed"), sec=$("#slotsSection");
  msg.classList.add("hidden");conf.classList.add("hidden");sec.classList.add("hidden");
  if(currentStudent.booking){
    const b=currentStudent.booking;
    conf.innerHTML=`<div class="eyebrow">BOOKING CONFIRMED</div><h2>预约已确认</h2>
      <div class="bookingline">${fmtDate(b.date)} ${esc(b.weekday||"")} · ${esc(b.start)}–${esc(b.end)}</div>
      <div>升导：${esc(currentStudent.cas)}　班主任：${esc(currentStudent.tutor)}</div>
      <div class="successactions"><button class="danger" id="cancelBookingBtn">取消预约</button></div>`;
    conf.classList.remove("hidden");
    $("#cancelBookingBtn").onclick=async()=>{if(!confirm("确定取消当前测试预约吗？"))return;try{const j=await api("/api/cancel",{token:currentToken});currentStudent=j.student;renderStudent();toast("预约已取消")}catch(e){alert(e.message)}};
    return;
  }
  if(currentStudent.availability_state==="coco_separate"){
    msg.textContent="该学生对应 Coco 关晓玉，本轮按现有安排另行预约，校内测试版暂不开放在线预约。";msg.classList.remove("hidden");return;
  }
  if(currentStudent.availability_state==="tutor_pending"){
    msg.textContent="G11-3 班主任 Ariel 的可用时间尚未录入，因此测试版暂不开放该班预约。";msg.classList.remove("hidden");return;
  }
  sec.classList.remove("hidden"); renderSlots(currentStudent.slots||[]);
}
function renderSlots(slots){
  const el=$("#slotsList"); el.innerHTML="";
  if(!slots.length){el.innerHTML='<div class="empty">目前没有已由 OP 发布的测试时段。请先在 Admin 后台生成或发布测试时段。</div>';return}
  const groups={}; slots.forEach(s=>(groups[s.date]??=[]).push(s));
  Object.keys(groups).sort().forEach(date=>{
    const title=document.createElement("div");title.className="slotdate";title.textContent=`${fmtDate(date)} · ${groups[date][0].weekday||""}`;el.appendChild(title);
    const grid=document.createElement("div");grid.className="slots";
    groups[date].forEach(s=>{
      const b=document.createElement("button");b.className="slot";
      b.innerHTML=`<b>${esc(s.start)}–${esc(s.end)}</b><small>${esc(casFull(s.cas_key))}</small>`;
      b.onclick=()=>openModal(s);grid.appendChild(b);
    });el.appendChild(grid);
  })
}
function openModal(s){pendingSlot=s;$("#modalText").textContent=`${currentStudent.zh_name} · ${fmtDate(s.date)} ${s.weekday||""} ${s.start}–${s.end} · ${currentStudent.cas}`;$("#modal").classList.remove("hidden")}
$("#cancelModal").onclick=()=>$("#modal").classList.add("hidden");
$("#confirmBooking").onclick=async()=>{if(!pendingSlot)return;try{const j=await api("/api/book",{token:currentToken,slot_key:pendingSlot.slot_key});currentStudent=j.student;$("#modal").classList.add("hidden");renderStudent();toast("预约成功")}catch(e){$("#modal").classList.add("hidden");alert(e.message);lookup(currentToken)}};

$("#adminLoginBtn").onclick=()=>adminLogin();
$("#adminPin").addEventListener("keydown",e=>{if(e.key==="Enter")adminLogin()});
async function adminLogin(){
  adminPin=$("#adminPin").value.trim();$("#adminError").classList.add("hidden");
  try{await loadAdmin();$("#adminLogin").classList.add("hidden");$("#adminPanel").classList.remove("hidden")}
  catch(e){$("#adminError").textContent=e.message;$("#adminError").classList.remove("hidden")}
}
async function loadAdmin(){
  const r=await fetch("/api/admin/state",{headers:{"X-Admin-Pin":adminPin}});
  const j=await r.json();if(!r.ok)throw new Error(j.error||"无法进入后台");adminState=j;
  renderAdmin();
}
async function exportCsv(){
  const r=await fetch("/api/admin/export.csv",{headers:{"X-Admin-Pin":adminPin}});
  if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error(j.error||"导出失败")}
  const blob=await r.blob();
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=url;a.download="G11_test_bookings.csv";document.body.appendChild(a);a.click();a.remove();
  URL.revokeObjectURL(url);
}
function renderAdmin(){renderStats();renderStudentTable();renderSlotTable();renderBookings()}
function renderStats(){
  const s=adminState.stats;$("#stats").innerHTML=[
    ["本轮学生",s.in_round],["已预约",s.booked],["已发布时段",s.published],["Coco另约",s.coco],["G11-3待班主任时间",s.g11_3]
  ].map(x=>`<div class="stat"><span>${esc(x[0])}</span><b>${x[1]}</b></div>`).join("");
}
function studentStatus(s){
  const b=adminState.bookings.find(x=>x.student_id===s.id&&x.status==="active");
  if(b)return `<span class="status-green">已预约 ${esc(b.date)} ${esc(b.start)}</span>`;
  if(s.cas_key==="Coco")return `<span class="status-amber">Coco另约</span>`;
  if(s.class_name==="G11-3")return `<span class="status-amber">待Ariel时间</span>`;
  return `<span>待预约</span>`;
}
function renderStudentTable(){
  const q=($("#studentSearch").value||"").toLowerCase();
  const rows=adminState.students.filter(s=>`${s.zh_name} ${s.en_name} ${s.class_name} ${s.cas}`.toLowerCase().includes(q));
  $("#studentTable").innerHTML=`<thead><tr><th>学生</th><th>班级</th><th>班主任</th><th>CAS</th><th>预约码</th><th>状态</th><th>测试</th></tr></thead><tbody>`+
    rows.map(s=>`<tr><td><b>${esc(s.zh_name)}</b><br><span class="muted">${esc(s.en_name)}</span></td><td>${esc(s.class_name)}</td><td>${esc(s.tutor)}</td><td>${esc(s.cas)}</td>
    <td><span class="code">${esc(s.token)}</span> <button class="ghost mini" onclick="copyText('${esc(s.token)}')">复制</button></td><td>${studentStatus(s)}</td>
    <td><button class="ghost mini" onclick="previewStudent('${esc(s.token)}')">家长端预览</button></td></tr>`).join("")+"</tbody>";
}
$("#studentSearch").oninput=()=>renderStudentTable();
window.copyText=async t=>{try{await navigator.clipboard.writeText(t);toast("已复制")}catch(e){prompt("复制预约码：",t)}}
window.previewStudent=t=>{switchView("parent");$("#bookingCode").value=t;lookup(t)};

function slotStatus(s){
  if(s.booked_student_id)return '<span class="status-green">已被预约</span>';
  if(s.published&&s.g12_locked)return '<span class="status-green">已发布</span>';
  if(s.g12_locked)return '<span class="status-amber">已锁定未发布</span>';
  return '<span>候选</span>';
}
function renderSlotTable(){
  const cas=$("#slotCasFilter").value, cls=$("#slotClassFilter").value;
  let rows=adminState.slots.filter(s=>(!cas||s.cas_key===cas)&&(!cls||s.eligible_classes.includes(cls)));
  $("#slotTable").innerHTML=`<thead><tr><th>日期</th><th>时间</th><th>CAS</th><th>可参与班级</th><th>G12锁定</th><th>家长发布</th><th>状态</th><th>操作</th></tr></thead><tbody>`+
    rows.map(s=>`<tr><td>${esc(s.date)}<br><span class="muted">${esc(s.weekday)}</span></td><td>${esc(s.start)}–${esc(s.end)}</td><td>${esc(s.cas_key)}</td><td>${s.eligible_classes.map(x=>`<span class="pill">${esc(x)}</span>`).join(" ")}</td>
    <td>${s.g12_locked?"✅":"—"}</td><td>${s.published?"✅":"—"}</td><td>${slotStatus(s)}</td>
    <td>${s.booked_student_id?'<span class="muted">已锁定</span>':s.published?`<button class="ghost mini" onclick="slotAction('${esc(s.slot_key)}','unpublish')">取消发布</button> <button class="danger mini" onclick="slotAction('${esc(s.slot_key)}','unlock')">解锁</button>`:`<button class="primary mini" onclick="slotAction('${esc(s.slot_key)}','lock_publish')">模拟锁定+发布</button>`}</td></tr>`).join("")+"</tbody>";
}
$("#slotCasFilter").onchange=renderSlotTable;$("#slotClassFilter").onchange=renderSlotTable;
window.slotAction=async(k,a)=>{try{await api("/api/admin/slot",{pin:adminPin,slot_key:k,action:a});await loadAdmin();toast("已更新")}catch(e){alert(e.message)}};

function renderBookings(){
  const rows=adminState.bookings;
  $("#bookingTable").innerHTML=`<thead><tr><th>学生</th><th>班级</th><th>CAS</th><th>面谈时间</th><th>记录状态</th><th>操作时间</th></tr></thead><tbody>`+
    (rows.length?rows.map(b=>`<tr><td>${esc(b.zh_name)}<br><span class="muted">${esc(b.en_name)}</span></td><td>${esc(b.class_name)}</td><td>${esc(b.cas_key)}</td><td>${esc(b.date)} ${esc(b.start)}–${esc(b.end)}</td><td>${esc(b.status)}</td><td>${esc(b.status==="active"?b.created_at:b.cancelled_at||b.created_at)}</td></tr>`).join(""):'<tr><td colspan="6" class="muted">暂无预约记录</td></tr>')+"</tbody>";
}
$("#samplePublish").onclick=async()=>{if(!confirm("将为 G11-1 / G11-2 各组模拟锁定少量时段，继续吗？"))return;try{const j=await api("/api/admin/sample-publish",{pin:adminPin});await loadAdmin();toast(`已发布 ${j.published} 个测试时段`)}catch(e){alert(e.message)}}
$("#resetTest").onclick=async()=>{if(!confirm("这会删除全部测试预约，并取消所有发布时段。确定重置吗？"))return;try{await api("/api/admin/reset",{pin:adminPin});await loadAdmin();toast("测试数据已重置")}catch(e){alert(e.message)}}

$("#exportCsv").onclick=async(e)=>{e.preventDefault();try{await exportCsv()}catch(err){alert(err.message)}};
