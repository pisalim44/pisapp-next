import { firebaseConfig, appCheckConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, addDoc, updateDoc, collection, query, where, orderBy, limit, onSnapshot, getDocs, serverTimestamp, Timestamp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { initializeAppCheck, ReCaptchaV3Provider } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app-check.js';

const app = initializeApp(firebaseConfig);
if (appCheckConfig?.enabled) initializeAppCheck(app, { provider: new ReCaptchaV3Provider(appCheckConfig.recaptchaV3SiteKey), isTokenAutoRefreshEnabled: true });
const auth = getAuth(app);
const db = getFirestore(app);

let CURRENT_USER = null;
let CURRENT_PROFILE = null;
let unsubWorklist = null, unsubDashboard = null;
let currentQSegExam = null;

const $ = id => document.getElementById(id);
const todayISO = () => new Date().toISOString().slice(0,10);
const setSync = txt => $('syncStatus').textContent = txt;
function safe(v){return v ?? ''}
function role(){return CURRENT_PROFILE?.perfil || 'guest'}
function canGovern(){return ['admin','governanca','gestor'].includes(role())}
function canBio(){return ['admin','biomedico','governanca','gestor'].includes(role())}

async function audit(action, details=''){
  if(!CURRENT_USER) return;
  await addDoc(collection(db,'auditLogs'), {action,details,uid:CURRENT_USER.uid,email:CURRENT_USER.email,nome:CURRENT_PROFILE?.nome||'',createdAt:serverTimestamp()});
}

$('btnLogin').onclick = async () => {
  $('loginErr').style.display='none';
  try { await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value); }
  catch(e){ $('loginErr').textContent = traduzErroAuth(e.code||e.message); $('loginErr').style.display='block'; }
};
$('btnLogout').onclick = () => signOut(auth);
function traduzErroAuth(c){ if(String(c).includes('invalid-credential')) return 'E-mail ou senha inválidos.'; return 'Erro no login: '+c; }

onAuthStateChanged(auth, async user => {
  if(!user){ CURRENT_USER=null; CURRENT_PROFILE=null; $('loginScreen').style.display='grid'; $('appShell').classList.remove('on'); return; }
  CURRENT_USER=user;
  const snap = await getDoc(doc(db,'users',user.uid));
  if(!snap.exists() || snap.data().ativo !== true){ await signOut(auth); alert('Usuário sem perfil ativo em users/{uid}.'); return; }
  CURRENT_PROFILE=snap.data();
  $('loginScreen').style.display='none'; $('appShell').classList.add('on');
  $('userInfo').textContent = `${CURRENT_PROFILE.nome||user.email} · ${CURRENT_PROFILE.perfil}`;
  $('wlDate').value = todayISO();
  bindDashboard(); bindWorklist(); loadRequests(); loadProjects(); loadEquipment(); loadDoctors();
  audit('login','PISApp Next');
});

document.querySelectorAll('.nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.nav button').forEach(x=>x.classList.remove('on'));b.classList.add('on');document.querySelectorAll('.section').forEach(s=>s.classList.remove('on'));$(b.dataset.sec).classList.add('on');$('pageTitle').textContent=b.textContent; if(b.dataset.sec==='worklist') bindWorklist();});

function bindDashboard(){
  if(unsubDashboard) unsubDashboard();
  const q = query(collection(db,'exams'), where('date','==',todayISO()));
  unsubDashboard = onSnapshot(q, snap=>{
    const arr=[]; snap.forEach(d=>arr.push(d.data()));
    $('dashToday').textContent=arr.length;
    $('dashPending').textContent=arr.filter(e=>['Agendado','Pendente'].includes(e.status)).length;
    $('dashRunning').textContent=arr.filter(e=>e.status==='Em andamento').length;
    $('dashDone').textContent=arr.filter(e=>e.status==='Concluído').length;
  });
}

$('btnRefreshWL').onclick=bindWorklist; $('wlDate').onchange=bindWorklist;
function bindWorklist(){
  if(unsubWorklist) unsubWorklist();
  setSync('Sincronizando Worklist...');
  const d = $('wlDate').value || todayISO();
  const q = query(collection(db,'exams'), where('date','==',d), orderBy('time','asc'));
  unsubWorklist = onSnapshot(q, snap=>{
    const rows=[]; snap.forEach(docu=>rows.push({id:docu.id,...docu.data()})); renderWorklist(rows); setSync('Realtime ativo');
  }, err=>{console.error(err); setSync('Erro Worklist');});
}
function renderWorklist(rows){
  $('wlBody').innerHTML = rows.length ? rows.map(e=>`<tr><td>${safe(e.time)}</td><td>${safe(e.code)}</td><td>${safe(e.subjectName)}</td><td>${safe(e.modality)}</td><td><span class="pill ${e.qSegSigned?'ok':'warn'}">${safe(e.status)}</span></td><td class="row"><button class="btnLine" onclick="window.openQSeg('${e.id}')">Q.Seg ${e.qSegSigned?'✓':''}</button><button class="btnLine" onclick="window.startExam('${e.id}')">Iniciar</button><button class="btnLine" onclick="window.finishExam('${e.id}')">Concluir</button></td></tr>`).join('') : '<tr><td colspan="6">Nenhum exame para a data.</td></tr>';
}
window.startExam=async id=>{ if(!canBio()) return alert('Sem permissão.'); await updateDoc(doc(db,'exams',id),{status:'Em andamento',startedAt:serverTimestamp(),updatedAt:serverTimestamp()}); await audit('exam.start',id); };
window.finishExam=async id=>{ if(!canBio()) return alert('Sem permissão.'); await updateDoc(doc(db,'exams',id),{status:'Concluído',finishedAt:serverTimestamp(),updatedAt:serverTimestamp()}); await audit('exam.finish',id); };
window.openQSeg=async id=>{
  currentQSegExam=id;
  const ex=await getDoc(doc(db,'exams',id)); if(!ex.exists()) return;
  const qs=await getDoc(doc(db,'qSeg',id));
  const data=qs.exists()?qs.data():{responses:{}};
  $('qSegInfo').innerHTML=`<p><b>${ex.data().subjectName}</b> · ${ex.data().modality} · ${ex.data().code}</p>`;
  const questions=['Marcapasso/dispositivo eletrônico?','Implante metálico?','Claustrofobia?','Gestação?','Alergia a contraste?','Doença renal?'];
  $('qSegItems').innerHTML=questions.map((q,i)=>{const val=data.responses?.[i]||'';return `<div class="field"><label>${i+1}. ${q}</label><select data-q="${i}"><option value="">Selecione</option><option ${val==='Não'?'selected':''}>Não</option><option ${val==='Sim'?'selected':''}>Sim</option></select></div>`}).join('');
  $('qSegAssinadoPor').value=CURRENT_PROFILE?.nome||''; $('qSegCRBM').value=CURRENT_PROFILE?.crbm||'';
  $('modalQSeg').classList.add('on');
};
$('btnSaveQSeg').onclick=async()=>{
  if(!currentQSegExam) return;
  const responses={}; let ok=true;
  document.querySelectorAll('#qSegItems select').forEach(s=>{ if(!s.value) ok=false; responses[s.dataset.q]=s.value; });
  if(!ok) return alert('Todos os itens são obrigatórios.');
  const prev=await getDoc(doc(db,'qSeg',currentQSegExam));
  await setDoc(doc(db,'qSegHistory',`${currentQSegExam}_${Date.now()}`), {examId:currentQSegExam,original:prev.exists()?prev.data().responses:{},newResponses:responses,updatedBy:CURRENT_USER.uid,updatedByName:CURRENT_PROFILE.nome,createdAt:serverTimestamp()});
  await setDoc(doc(db,'qSeg',currentQSegExam), {examId:currentQSegExam,responses,signed:true,signedBy:CURRENT_USER.uid,signedByName:$('qSegAssinadoPor').value,signedCRBM:$('qSegCRBM').value,signedAt:serverTimestamp(),updatedAt:serverTimestamp()}, {merge:true});
  await updateDoc(doc(db,'exams',currentQSegExam),{qSegSigned:true,updatedAt:serverTimestamp()});
  await audit('qseg.sign',currentQSegExam);
  $('modalQSeg').classList.remove('on');
};

async function loadRequests(){ const q=query(collection(db,'requests'), orderBy('createdAt','desc'), limit(50)); onSnapshot(q,s=>{$('reqBody').innerHTML=[...s.docs].map(x=>{const r=x.data();return `<tr><td>${fmt(r.createdAt)}</td><td>${r.institute||''}</td><td>${r.subjectName||''}</td><td>${(r.modalities||[]).join(', ')}</td><td>${r.status||''}</td></tr>`}).join('')||'<tr><td colspan="5">Sem solicitações.</td></tr>';}); }
async function loadProjects(){ const q=query(collection(db,'projects'), orderBy('createdAt','desc'), limit(50)); onSnapshot(q,s=>{$('projBody').innerHTML=[...s.docs].map(x=>{const p=x.data();return `<tr><td>${p.dro||''}</td><td>${p.nickname||''}</td><td>${p.title||''}</td><td>${p.hasReport?'Sim':'Não'}</td><td>${p.ethicsBlocked?'Bloqueado':'OK'}</td></tr>`}).join('')||'<tr><td colspan="5">Sem projetos.</td></tr>';}); }
async function loadEquipment(){ const q=query(collection(db,'equipment'), orderBy('createdAt','desc'), limit(50)); onSnapshot(q,s=>{$('eqBody').innerHTML=[...s.docs].map(x=>{const e=x.data();return `<tr><td>${e.name||''}</td><td>${e.modality||''}</td><td>${e.model||''}</td><td>${e.softwareVersion||''}</td><td>${e.status||''}</td><td><button class="btnLine" onclick="window.eqMaint('${x.id}')">Manutenção</button></td></tr>`}).join('')||'<tr><td colspan="6">Sem equipamentos.</td></tr>';}); }
async function loadDoctors(){ const q=query(collection(db,'doctors'), orderBy('name','asc')); onSnapshot(q,s=>{$('docBody').innerHTML=[...s.docs].map(x=>{const d=x.data();return `<tr><td>${d.name}</td><td>${d.active?'Sim':'Não'}</td><td>${fmt(d.createdAt)}</td></tr>`}).join('')||'<tr><td colspan="3">Sem médicos.</td></tr>';}); }
window.eqMaint=async id=>{ if(!canGovern()) return alert('Sem permissão.'); const ref=doc(db,'equipment',id); const snap=await getDoc(ref); await addDoc(collection(db,'equipmentLogs'),{equipmentId:id,previousStatus:snap.data().status,newStatus:'Manutenção',userId:CURRENT_USER.uid,userName:CURRENT_PROFILE.nome,createdAt:serverTimestamp()}); await updateDoc(ref,{status:'Manutenção',updatedAt:serverTimestamp()}); await audit('equipment.status',id); };

$('btnNewReq').onclick=async()=>{await addDoc(collection(db,'requests'),{createdAt:serverTimestamp(),institute:'PISA',subjectName:'Teste '+Date.now(),modalities:['RM 7T'],status:'Pendente',createdBy:CURRENT_USER.uid});};
$('btnNewProject').onclick=async()=>{await addDoc(collection(db,'projects'),{createdAt:serverTimestamp(),dro:'DRO_'+Date.now(),title:'Projeto teste',nickname:'TESTE',hasReport:false,ethicsBlocked:false,createdBy:CURRENT_USER.uid});};
$('btnNewEquip').onclick=async()=>{await addDoc(collection(db,'equipment'),{createdAt:serverTimestamp(),name:'Equipamento teste',modality:'TC',model:'Modelo',softwareVersion:'1.0',status:'Operacional',createdBy:CURRENT_USER.uid});};
$('btnNewDoctor').onclick=async()=>{if(!canGovern())return alert('Sem permissão.'); await addDoc(collection(db,'doctors'),{createdAt:serverTimestamp(),name:'Dr(a). Teste '+Date.now(),active:true,createdBy:CURRENT_USER.uid});};
$('btnAudit').onclick=async()=>{const q=query(collection(db,'auditLogs'), orderBy('createdAt','desc'), limit(100)); const s=await getDocs(q); $('auditBody').innerHTML=[...s.docs].map(x=>{const a=x.data();return `<tr><td>${fmt(a.createdAt)}</td><td>${a.action}</td><td>${a.email||a.nome||''}</td><td>${a.details||''}</td></tr>`}).join('');};
function fmt(ts){ if(!ts) return ''; const d = ts instanceof Timestamp ? ts.toDate() : new Date(ts); return isNaN(d)?'':d.toLocaleString('pt-BR'); }
