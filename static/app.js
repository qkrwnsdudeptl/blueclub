const state = {items:[], partners:[], summary:{}, transactions:[], businesses:[], view:localStorage.getItem('inventoryView')||'dashboard', businessId:'delivery', admin:false};
const labels = {PURCHASE:'매입', SALE:'매출', ISSUE:'불출', RETURN_IN:'반품입고', RETURN_OUT:'반품출고', ADJUST_IN:'조정입고', ADJUST_OUT:'조정출고'};
const $ = (s) => document.querySelector(s);
const money = (n) => `${Number(n||0).toLocaleString('ko-KR')}원`;
const qty = (n) => Number(n||0).toLocaleString('ko-KR');
const stockDisplay = (n) => n === null || n === undefined ? '미조사' : qty(n);
const today = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2200)}
async function api(url, options={}){const headers={'Content-Type':'application/json','X-Business-ID':state.businessId,...(options.headers||{})};const res=await fetch(url,{...options,headers});const data=await res.json();if(!res.ok)throw new Error(data.error||'요청을 처리하지 못했습니다.');return data}
async function refresh(renderView=true){[state.summary,state.items,state.partners,state.transactions]=await Promise.all([api('/api/summary'),api('/api/items'),api('/api/partners'),api('/api/transactions')]);applyBusinessTheme();if(renderView)render();}

const rememberedBusinessKey = 'inventoryRememberedBusiness';
const isBusiness = id => state.businesses.some(b => b.id === id);

async function initialize() {
  try {
    state.businesses = await api('/api/businesses');
    const navigation = performance.getEntriesByType('navigation')[0];
    const current = navigation?.type === 'reload' ? history.state?.inventoryBusiness : null;
    const remembered = localStorage.getItem(rememberedBusinessKey);
    const selected = isBusiness(current) ? current : remembered;
    if (isBusiness(selected)) {
      await enterBusiness(selected, state.view);
    } else {
      await showWelcome();
    }
  } catch (err) {
    $('#welcome-error').textContent = err.message;
    if (state.businesses.length) await showWelcome();
    else $('#welcome-page').hidden = false;
  }
}

async function enterBusiness(id, view='dashboard') {
  setBusiness(id);
  await refresh(false);
  history.replaceState({ ...history.state, inventoryBusiness: id }, '');
  $('#welcome-page').hidden = true;
  $('#app-shell').hidden = false;
  setView(view==='production' || $(`[data-view="${CSS.escape(view)}"]`) ? view : 'dashboard');
}

async function showWelcome(preselect='') {
  history.replaceState({ ...history.state, inventoryBusiness: null }, '');
  $('#app-shell').hidden = true;
  $('#welcome-page').hidden = false;
  document.body.dataset.theme = 'teal';
  document.body.dataset.admin = 'false';
  const form = $('#welcome-form');
  form.elements.business.replaceChildren(new Option('사업단을 선택하세요', ''));
  for (const business of state.businesses) {
    form.elements.business.add(new Option(business.name, business.id));
  }
  form.elements.business.value = preselect;
  form.elements.remember.checked = !!preselect && preselect === localStorage.getItem(rememberedBusinessKey);
  try {
    const settings = await api('/api/welcome');
    $('#welcome-title').textContent = settings.title;
    $('#welcome-message').textContent = settings.message;
  } catch (err) {
    $('#welcome-error').textContent = err.message;
  }
  form.querySelector('button').disabled = false;
  $('#welcome-title').focus();
}

$('#welcome-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.business.value;
  if (!isBusiness(id)) return;
  const remember = form.elements.remember.checked;
  const button = form.querySelector('button');
  button.disabled = true;
  $('#welcome-error').textContent = '';
  try {
    await enterBusiness(id);
    if (remember) localStorage.setItem(rememberedBusinessKey, id);
    else localStorage.removeItem(rememberedBusinessKey);
  } catch (err) {
    $('#welcome-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

function setBusiness(id){
  if(!isBusiness(id))return;
  state.businessId=id;
  applyBusinessTheme();
}
function applyBusinessTheme(){
  const business=state.businesses.find(b=>b.id===state.businessId);
  document.body.dataset.theme=business?.theme||'teal';
  const select=$('#business-switcher');
  select.replaceChildren(...state.businesses.map(b=>new Option(b.name,b.id)),new Option('접속 사업단 설정…','welcome'));
  select.value=state.businessId;
}
async function switchBusiness(id){setBusiness(id);await refresh(false);setView(state.view)}
function setView(view) {
  if (view === 'entry') view = 'ledger';
  if (view === 'production' && !productionEnabled()) view = 'ledger';
  if ((view==='work' && !productionEnabled()) || (view==='cafe' && state.businessId!=='cafe')) view = 'counts';
  state.view = view;
  localStorage.setItem('inventoryView',view);
  const report = ['daily','monthly','calendar'].includes(view);
  const manage = ['items','partners','import'].includes(view);
  const operations = Object.hasOwn(operationTitles,view);
  const group = report ? 'daily' : manage ? 'items' : operations ? 'counts' : view==='production' ? 'ledger' : view;
  $('#report-tabs').hidden = !report;
  $('#manage-tabs').hidden = !manage;
  $('#operations-tabs').hidden = !operations;
  $('#operations-tabs [data-view="work"]').hidden = !productionEnabled();
  $('#operations-tabs [data-view="cafe"]').hidden = state.businessId!=='cafe';
  document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.view===group));
  document.querySelectorAll('.subnav .tab').forEach(x=>x.classList.toggle('active',x.dataset.view===view));
  document.querySelectorAll('.view').forEach(x=>x.classList.toggle('active',x.id===`view-${view}`));
  $('#page-title').textContent={...operationTitles,dashboard:'홈',ledger:'거래 장부',production:'완성품 만들기',daily:'일일 운영일지',monthly:'월간 거래요약',calendar:'달력 대장',items:'품목 관리',partners:'기관·거래처',import:'엑셀 가져오기',admin:'관리자 대시보드'}[view];
  render();
}
document.querySelectorAll('[data-view]').forEach(x=>x.addEventListener('click',()=>setView(x.dataset.view)));
$('#business-switcher').addEventListener('change', async event => {
  const selected = event.target.value;
  if (selected === 'welcome') {
    await showWelcome(state.businessId);
    return;
  }
  const previous = state.businessId;
  $('#app-shell').inert = true;
  try {
    await switchBusiness(selected);
    history.replaceState({ ...history.state, inventoryBusiness: selected }, '');
  } catch (err) {
    setBusiness(previous);
    toast(err.message);
  } finally {
    $('#app-shell').inert = false;
  }
});
function render(){document.body.dataset.admin=state.view==='admin'?'true':'false';if(state.view==='dashboard')renderDashboard();if(state.view==='entry')renderEntry();if(state.view==='daily')renderDaily();if(state.view==='monthly')renderMonthly();if(state.view==='calendar')renderCalendar();if(state.view==='ledger')renderLedger();if(state.view==='production')renderProduction();if(state.view==='items')renderItems();if(state.view==='partners')renderPartners();if(state.view==='import')renderImport();if(state.view==='admin')renderAdmin();if(Object.hasOwn(operationTitles,state.view))renderOperations(state.view)}
const printOptions={daily:[['no','순번'],['item','품명'],['unit','단위'],['unitPrice','단가'],['tax','면·과세'],['opening','시작재고'],['purchase','매입'],['otherIn','조정·반품 입고'],['sale','매출'],['otherOut','조정·반품 출고'],['closing','종료일 재고'],['delta','전일 대비 증감'],['salesAmount','판매금액'],['note','비고']],monthly:[['kpiPurchase','큰 네모: 월 매입'],['kpiSale','큰 네모: 월 매출'],['kpiIssue','큰 네모: 월 불출'],['kpiItems','큰 네모: 조회 품목'],['item','품명'],['unit','단위'],['opening','월초재고'],['purchase','매입'],['sale','매출'],['issue','불출'],['adjustment','조정'],['closing','월말재고'],['purchaseAmount','매입금액'],['salesAmount','매출금액']]};
function openPrintDialog(kind,options=printOptions[kind]||printOptions.daily){
  let dialog=$('#print-dialog');
  if(dialog)dialog.remove();
  dialog=document.createElement('dialog');dialog.id='print-dialog';dialog.className='print-dialog';
  dialog.innerHTML=`<div class="print-dialog-head"><div><h2>인쇄 항목 선택</h2><small>${kind==='monthly'?'월간 거래요약':'일일 재고 내역'}에서 인쇄할 항목을 선택하세요.</small></div><button type="button" class="dialog-close" aria-label="닫기">×</button></div><form method="dialog" class="print-dialog-body"><div class="print-option-grid">${options.map(([key,label])=>`<label><input type="checkbox" name="${key}" value="1" ${key!=='delta'||dailyShowDelta?'checked':''}><span>${label}</span></label>`).join('')}</div><p class="print-dialog-note">선택한 항목만 문서에 표시됩니다. PDF 저장은 다음 인쇄 화면에서 선택하세요.</p><div class="form-actions"><button type="button" class="button ghost" data-cancel>취소</button><button type="submit" class="button primary">선택 항목 인쇄</button></div></form>`;
  document.body.appendChild(dialog);
  dialog.querySelector('.dialog-close').addEventListener('click',()=>dialog.close());
  dialog.querySelector('[data-cancel]').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  dialog.querySelector('form').addEventListener('submit',e=>{e.preventDefault();const selected=[...dialog.querySelectorAll('input:checked')].map(x=>x.name);dialog.close();applyPrintSelection(kind,selected);setTimeout(()=>window.print(),80)});
  dialog.showModal();
}
function applyPrintSelection(kind,selected){
  document.body.dataset.printKind=kind;
  const section = $(`#view-${kind}`);
  section.querySelectorAll('[data-print-key]').forEach(el=>el.classList.toggle('print-hidden',!selected.includes(el.dataset.printKey)));
  section.querySelectorAll('[data-print-span]').forEach(el=>{
    el.dataset.printSpan = el.colSpan;
    el.colSpan = Math.max(1,selected.length);
  });
}
function clearPrintSelection(){
  document.body.removeAttribute('data-print-kind');
  document.querySelectorAll('.print-hidden').forEach(el=>el.classList.remove('print-hidden'));
  document.querySelectorAll('[data-print-span]').forEach(el=>{
    if (el.dataset.printSpan) el.colSpan = Number(el.dataset.printSpan);
  });
}
window.addEventListener('afterprint',clearPrintSelection);
const homeWidgetLabels = {
  items:'등록 품목', purchase:'오늘 매입', sale:'오늘 매출',
  amount:'오늘 거래금액', stock:'재고 현황', recent:'최근 거래',
};

function homeWidgets(summary, items, transactions) {
  const count = (label, value, unit='') => `<div class="card kpi"><div class="label">${label}</div><div class="value">${value}<small>${unit}</small></div></div>`;
  const ranked = items.filter(i=>i.item_type!=='SERVICE' && i.stock_mode!=='snapshot').sort((a,b)=>{
    const rank = i => i.stock<=0 ? 0 : i.stock<=i.min_stock ? 1 : 2;
    return rank(a)-rank(b) || a.stock-b.stock || a.name.localeCompare(b.name,'ko');
  });
  const empty = ranked.filter(i=>i.stock<=0);
  const low = ranked.filter(i=>i.stock>0 && i.stock<=i.min_stock);
  const stockList = ranked.map(i=>`<div class="stock-row"><strong>${escapeHtml(i.name)}</strong><span>${qty(i.stock)} ${escapeHtml(i.unit)}</span><span>${i.stock<=0?'품절':i.stock<=i.min_stock?'부족':'정상'}</span></div>`).join('');
  return {
    items: count(homeWidgetLabels.items, qty(summary.item_count), '개'),
    purchase: count(homeWidgetLabels.purchase, qty(summary.purchase_qty)),
    sale: count(homeWidgetLabels.sale, money(summary.sale_amount), ` · 판매 ${qty(summary.sale_qty)}`),
    amount: count(homeWidgetLabels.amount, money(summary.today_amount)),
    stock: `<div class="card"><div class="card-head"><h2>재고 확인</h2><small>${escapeHtml(summary.today||today())} 기준</small></div><div class="card-body"><p>품절 ${empty.length}개 · 부족 ${low.length}개</p><details><summary>전체 재고 보기</summary><div class="low-stock stock-list-scroll" tabindex="0">${stockList||'<p>등록된 재고품이 없습니다.</p>'}</div></details></div></div>`,
    recent: `<div class="card"><div class="card-head"><h2>최근 거래</h2><button class="button ghost" onclick="setView('ledger')">거래 장부</button></div><div class="table-wrap">${transactionTable(transactions.slice(0,6))}</div></div>`,
  };
}

function renderDashboard() {
  const business = state.businesses.find(b=>b.id===state.businessId);
  const blocks = Object.entries(homeWidgets(state.summary,state.items,state.transactions))
    .filter(([key])=>business?.widgets?.[key]!==false)
    .map(([key, html])=>`<div class="${['stock','recent'].includes(key)?'home-wide':''}">${html}</div>`);
  const dailyItems = state.items.filter(i=>i.item_type==='STOCK' && i.count_frequency==='daily').length;
  const actions = [
    {label:'거래 기록',detail:'매입·판매·재고 조정',action:"openTransactionDialog()",icon:'↗'},
    {label:'오늘 실사',detail:`매일 확인 품목 ${dailyItems}개`,action:"openTodayCounts()",icon:'✓'},
    ...(productionEnabled() ? [{label:'작업일지',detail:'작업 실적과 생산 재고',action:"setView('work')",icon:'▥'}] :
      state.businessId==='cafe' ? [{label:'카페 레시피',detail:'판매 메뉴와 재료 연결',action:"setView('cafe')",icon:'◈'}] : []),
    {label:'발주 확인',detail:'입고 예정과 부족 예상',action:"setView('planning')",icon:'→'},
  ];
  $('#view-dashboard').innerHTML = `
    <section class="workspace-hero"><div><p class="eyebrow">오늘의 업무</p>
      <h2>${escapeHtml(business?.name||'사업단')}의 하루를 한눈에.</h2>
      <p>거래를 기록하고, 필요한 재고를 확인하세요.</p></div>
      <button class="button primary" onclick="openTransactionDialog()">＋ 거래 입력</button></section>
    <div class="workspace-actions">${actions.map(a=>`<button type="button" class="workspace-action" onclick="${a.action}">
      <span class="action-icon" aria-hidden="true">${a.icon}</span><span><strong>${a.label}</strong><small>${a.detail}</small></span>
      <span class="action-arrow" aria-hidden="true">↗</span></button>`).join('')}</div>
    <div class="workspace-section-title"><h2>사업단 현황</h2><span>${today()} 기준</span></div>
    <div class="home-grid">${blocks.join('')||'<p>관리자에서 표시할 홈 항목을 설정할 수 있습니다.</p>'}</div>`;
}

function openTodayCounts(){
  const preferences = operationSettings.get(state.businessId);
  if(preferences){preferences.scope='daily';preferences.date=today();}
  setView('counts');
}

function renderEntry(){
  const options = state.items.map(i=>`<option value="${i.id}">${escapeHtml(i.name)} (${i.item_type==='SERVICE'?'용역·서비스':qty(i.stock)+' '+escapeHtml(i.unit)})</option>`).join('');
  const partners = state.partners.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  $('#view-entry').innerHTML = `
    <div class="card">
      <div class="card-head"><div><h2>거래 입력</h2><small>매입·매출·불출·재고 조정을 한 건씩 기록합니다.</small></div></div>
      <div class="card-body"><form id="entry-form">
        <p id="entry-error" class="entry-error" role="alert" tabindex="-1" hidden></p>
        <div class="form-grid three">
          <div class="field"><label for="entry-date">거래일자</label><input id="entry-date" type="date" name="transaction_date" value="${today()}" required></div>
          <div class="field"><label for="entry-kind">거래구분</label><select id="entry-kind" name="transaction_type">
            <option value="PURCHASE">매입 · 입고</option><option value="SALE">매출 · 판매</option><option value="ISSUE">불출 · 기관 제공</option>
            <option value="RETURN_IN">반품 입고</option><option value="RETURN_OUT">반품 출고</option><option value="ADJUST">재고 조정</option>
          </select></div>
          <div class="field" data-adjustment hidden><label for="entry-adjustment-mode">재고 조정 방법</label><select id="entry-adjustment-mode" name="adjustment_mode" required disabled>
            <option value="">선택하세요</option>
            <option value="increase">증가</option><option value="decrease">감소</option><option value="set">수량 변경</option>
          </select></div>
          <div class="field"><label for="entry-item">품목</label><select id="entry-item" name="item_id" required>${options||'<option value="">먼저 품목을 등록하세요</option>'}</select></div>
          <div class="field"><label for="entry-partner">기관·거래처</label><select id="entry-partner" name="partner_id"><option value="">선택 안 함</option>${partners}</select></div>
          <div class="field"><label for="entry-quantity">수량</label><input id="entry-quantity" type="number" min="1" name="quantity" placeholder="예: 100" aria-describedby="entry-stock-hint" required>
            <small id="entry-stock-hint" hidden></small></div>
          <div class="field"><label for="entry-price">단가(원)</label><input id="entry-price" type="number" min="0" name="unit_price" placeholder="예: 2170"></div>
        </div>
        <div class="field" style="margin-top:14px"><label for="entry-note">비고</label><input id="entry-note" name="note" placeholder="필요한 경우 메모를 입력하세요"></div>
        <div class="form-actions"><button type="button" class="button ghost" data-entry-cancel>취소</button><button class="button primary">저장하기</button></div>
      </form></div>
    </div>
    <div class="card section" style="margin-top:18px"><div class="card-head"><h2>오늘 입력 내역</h2><small>${today()}</small></div>
      <div class="table-wrap">${transactionTable(state.transactions.filter(x=>x.transaction_date===today()))}</div></div>`;

  const form = $('#entry-form');
  form.dataset.requestId = productionToken();
  const {transaction_type, adjustment_mode, item_id, quantity} = form.elements;
  const adjustmentField = form.querySelector('[data-adjustment]');
  const quantityLabel = quantity.labels[0];
  const stockHint = form.querySelector('#entry-stock-hint');
  let wasTarget = false;
  function updateAdjustment(){
    const adjusting = transaction_type.value==='ADJUST';
    const target = adjusting && adjustment_mode.value==='set';
    if(target!==wasTarget) quantity.value = '';
    wasTarget = target;
    adjustmentField.hidden = !adjusting;
    adjustment_mode.disabled = !adjusting;
    quantity.min = target ? '0' : '1';
    quantity.placeholder = target ? '예: 400' : '예: 100';
    const adjustmentLabels = {increase:'증가 수량',decrease:'감소 수량',set:'변경 후 재고'};
    quantityLabel.textContent = (adjusting && adjustmentLabels[adjustment_mode.value]) || '수량';
    const item = state.items.find(i=>String(i.id)===item_id.value);
    stockHint.hidden = !adjusting || !item;
    stockHint.textContent = !item ? '' : item.item_type==='SERVICE' ? '재고품만 재고를 조정할 수 있습니다.' :
      `현재 재고 ${qty(item.stock)} ${item.unit}${target ? ' · 저장 시점 재고 기준으로 차이를 기록합니다.' : ''}`;
  }
  [transaction_type, adjustment_mode, item_id].forEach(field=>field.addEventListener('change',updateAdjustment));
  updateAdjustment();
  form.addEventListener('submit', saveTransaction);
  form.querySelector('[data-entry-cancel]').onclick = ()=>{
    const dialog = form.closest('dialog');
    if (dialog?.open) dialog.close();
    else setView('dashboard');
  };
}

function confirmZeroPrice() {
  const dialog = $('#zero-price-dialog');
  dialog.returnValue = '';
  return new Promise(resolve=>{
    dialog.addEventListener('close',()=>resolve(dialog.returnValue==='save'),{once:true});
    dialog.showModal();
    dialog.querySelector('[value="save"]').focus();
  });
}

async function saveTransaction(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button.primary');
  if (submit.disabled) return;
  const error = form.querySelector('#entry-error');
  error.hidden = true;
  const data = Object.fromEntries(new FormData(form));
  const business = state.businessId;
  if(business==='cafe' && data.transaction_type==='SALE') data.request_id = form.dataset.requestId;
  let result;
  submit.disabled = true;
  try {
    if (data.unit_price==='') {
      if (!await confirmZeroPrice()) {
        form.elements.unit_price.focus();
        return;
      }
      data.unit_price = '0';
    }
    result = await api('/api/transactions',{method:'POST', headers:{'X-Business-ID':business}, body:JSON.stringify(data)});
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    error.focus();
    error.scrollIntoView({block:'nearest'});
    return;
  } finally {
    submit.disabled = false;
  }
  form.closest('dialog')?.close();
  toast(result.unchanged ? '현재 재고와 같아 조정 내역을 기록하지 않았습니다.' :
    result.low_materials?.length ? `거래 저장 · 재료 장부 재고 확인: ${result.low_materials.join(', ')}` : '거래가 저장되었습니다.');
  try { await refresh(); }
  catch (err) { toast('거래는 저장됐지만 목록을 새로고침하지 못했습니다.'); }
}

function renderPartners(){$('#view-partners').innerHTML=`<div class="card section"><div class="card-head"><div><h2>기관·거래처 관리</h2><small>불출 기관과 매입처를 하나의 목록으로 관리합니다.</small></div></div><div class="card-body"><form id="partner-form"><div class="form-grid"><div class="field"><label>기관·거래처명</label><input name="name" placeholder="예: ○○복지관" required></div><div class="field"><label>구분</label><select name="kind"><option>기관</option><option>공급처</option><option>기타</option></select></div></div><div class="form-actions"><button class="button primary">목록에 추가</button></div></form></div></div><div class="card"><div class="card-head"><h2>등록 목록 ${state.partners.length}개</h2></div><div class="table-wrap"><table class="data-table"><thead><tr><th>이름</th><th>구분</th></tr></thead><tbody>${state.partners.map(p=>`<tr><td><strong>${p.name}</strong></td><td>${p.kind}</td></tr>`).join('')}</tbody></table></div></div>`;$('#partner-form').addEventListener('submit',async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.target));try{await api('/api/partners',{method:'POST',body:JSON.stringify(data)});toast('기관·거래처가 추가되었습니다.');await refresh()}catch(err){toast(err.message)}})}
async function removeTx(id){if(!confirm('이 거래를 삭제할까요?'))return;try{await api(`/api/transactions/${id}`,{method:'DELETE'});toast('거래가 삭제되었습니다.');await refresh()}catch(err){toast(err.message)}}
$('#today-label').textContent=new Date().toLocaleDateString('ko-KR',{year:'numeric',month:'long',day:'numeric',weekday:'short'});
initialize();
// Extended daily form matching the upper section of the supplied operating-log workbook.

async function fileToBase64(file){const bytes=new Uint8Array(await file.arrayBuffer());let binary='';const chunk=0x8000;for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));return btoa(binary)}


// 품목 삭제는 거래 이력을 지우지 않는 사용중지 방식으로 처리한다.
async function renderItems(){
  const target=$('#view-items');
  target.innerHTML='<div class="card"><div class="card-body empty">품목 목록을 불러오는 중입니다...</div></div>';
  try{
    const items=await api('/api/items?all=1');
    const e=(v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
    const activeCount=items.filter(i=>i.active).length;
    target.innerHTML=`<div class="card section"><div class="card-head"><div><h2>품목 관리</h2><small>재고품은 수량을 관리하고, 용역·서비스는 매출만 관리합니다.</small></div></div><div class="card-body"><form id="item-form"><div class="form-grid three"><div class="field"><label>품목명</label><input name="name" placeholder="예: 종량제봉투(75L)" required></div><div class="field"><label>품목 유형</label><select name="item_type"><option value="STOCK">재고품</option><option value="SERVICE">용역·서비스</option></select></div><div class="field"><label>단위</label><input name="unit" value="개"></div><div class="field"><label>기본 단가(원)</label><input type="number" name="unit_price" value="0" min="0"></div><div class="field"><label>과세구분</label><select name="tax_type"><option>면세</option><option>과세</option></select></div><div class="field"><label>최소재고</label><input type="number" name="min_stock" value="0" min="0"></div></div><div class="form-actions"><button class="button primary">품목 추가</button></div></form></div></div><div class="card"><div class="card-head"><div><h2>사용 품목 ${activeCount}개</h2><small>사용중지 ${items.length-activeCount}개${state.admin?' · 관리자 완전삭제 가능':''}</small></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>상태</th><th>품목명</th><th>유형</th><th>단위</th><th>기본단가</th><th>과세</th><th>최소재고</th><th>현재재고</th><th>관리</th></tr></thead><tbody>${items.map(i=>`<tr class="${i.active?'':'inactive-row'}"><td><span class="badge ${i.active?'purchase':'inactive'}">${i.active?'사용중':'사용중지'}</span></td><td><strong>${e(i.name)}</strong></td><td>${i.item_type==='SERVICE'?'용역·서비스':'재고품'}</td><td>${e(i.unit)}</td><td>${money(i.unit_price)}</td><td>${e(i.tax_type)}</td><td>${i.item_type==='SERVICE'?'':qty(i.min_stock)}</td><td class="${i.item_type!=='SERVICE'&&i.stock_mode!=='snapshot'&&i.active&&i.stock<=i.min_stock?'danger-text':''}">${i.item_type==='SERVICE'?'':i.stock_mode==='snapshot'?(i.last_count?qty(i.last_count.quantity)+' '+e(i.unit)+' · '+i.last_count.report_date:'미조사'):qty(i.stock)+' '+e(i.unit)}</td><td><div class="quick-actions">${i.active?`<button class="button ghost" onclick="editItem(${i.id})">수정</button><button class="button danger" onclick="deactivateItem(${i.id})">삭제</button>`:`<button class="button ghost" onclick="restoreItem(${i.id})">복구</button>`}${state.admin?`<button class="button danger" onclick="hardDeleteItem(${i.id})">완전삭제</button>`:''}</div></td></tr>`).join('')||'<tr><td colspan="9" class="empty">등록된 품목이 없습니다.</td></tr>'}</tbody></table></div></div>`;
    target.insertAdjacentHTML('beforeend',`<dialog id="item-edit-dialog" class="edit-dialog"><div class="edit-dialog-head"><div><h2>품목 정보 수정</h2><small id="edit-item-caption">등록 정보를 한 번에 확인하고 수정합니다.</small></div><button type="button" class="dialog-close" onclick="closeItemEditor()" aria-label="닫기">×</button></div><form id="item-edit-form"><input type="hidden" name="id"><div class="form-grid"><div class="field edit-wide"><label>품목명</label><input name="name" required></div><div class="field"><label>품목 유형</label><select name="item_type"><option value="STOCK">재고품</option><option value="SERVICE">용역·서비스</option></select></div><div class="field"><label>단위</label><input name="unit" required></div><div class="field"><label>기본 단가(원)</label><input type="number" name="unit_price" min="0" required></div><div class="field"><label>과세구분</label><select name="tax_type"><option value="면세">면세</option><option value="과세">과세</option></select></div><div class="field"><label>최소재고</label><input type="number" name="min_stock" min="0" required></div></div><div class="form-actions"><button type="button" class="button ghost" onclick="closeItemEditor()">취소</button><button class="button primary">변경사항 저장</button></div></form></dialog>`);
    target.querySelector('#item-form').addEventListener('submit',async ev=>{ev.preventDefault();const data=Object.fromEntries(new FormData(ev.target));try{await api('/api/items',{method:'POST',body:JSON.stringify(data)});toast('품목이 추가되었습니다.');$('#item-create-dialog')?.close();await refresh()}catch(err){toast(err.message)}});
    $('#item-edit-form').addEventListener('submit',saveItemEdit);
    $('#item-edit-dialog').addEventListener('click',ev=>{if(ev.target.id==='item-edit-dialog')closeItemEditor()});
    const registration = target.firstElementChild;
    const createDialog = document.createElement('dialog');
    createDialog.id = 'item-create-dialog';
    createDialog.className = 'edit-dialog';
    createDialog.setAttribute('aria-label','품목 추가');
    createDialog.append(registration);
    registration.classList.remove('section');
    registration.querySelector('.form-grid').classList.remove('three');
    registration.querySelector('input[name="name"]').closest('.field').classList.add('edit-wide');
    registration.querySelector('h2').textContent = '품목 추가';
    registration.querySelector('.card-head').insertAdjacentHTML('beforeend','<button class="dialog-close" type="button" aria-label="닫기">×</button>');
    createDialog.querySelector('.dialog-close').onclick = ()=>createDialog.close();
    target.append(createDialog);
    target.insertAdjacentHTML('afterbegin', `<div class="toolbar item-tools">
      <div class="quick-actions">
        <input type="search" aria-label="품목 검색" placeholder="품목명 검색">
        <select aria-label="품목 유형"><option value="">전체 유형</option><option value="STOCK">재고품</option><option value="SERVICE">용역·서비스</option></select>
      </div>
      <div class="quick-actions">
        <button class="button ghost" type="button" data-stocktake>재고조사표 Word 다운로드</button>
        <button class="button primary" type="button" data-item-add>＋ 품목 추가</button>
      </div>
    </div>`);
    const tools = target.querySelector('.item-tools');
    const nameFilter = tools.querySelector('input');
    const typeFilter = tools.querySelector('select');
    const rows = target.querySelectorAll('.data-table tbody tr');
    const filter = ()=>{
      const term = nameFilter.value.trim().toLowerCase();
      const type = typeFilter.value;
      items.forEach((item,index)=>{
        rows[index].hidden = !item.name.toLowerCase().includes(term) || (type && item.item_type!==type);
      });
    };
    nameFilter.addEventListener('input',filter);
    typeFilter.addEventListener('change',filter);
    tools.querySelector('[data-item-add]').onclick = ()=>createDialog.showModal();
    tools.querySelector('[data-stocktake]').onclick = ()=>openStocktakeDialog(target, items);
    window.allItems=items;window.itemManagementItems=items;
  }catch(err){target.innerHTML=`<div class="card"><div class="card-body empty">${err.message}</div></div>`}
}
function openStocktakeDialog(target, items, initialScope='all'){
  const stockItems = items.filter(item=>item.active && item.item_type==='STOCK');
  const dialog = document.createElement('dialog');
  dialog.className = 'edit-dialog';
  dialog.setAttribute('aria-labelledby','stocktake-title');
  dialog.innerHTML = `
    <div class="edit-dialog-head"><div>
      <h2 id="stocktake-title">재고조사표 Word 다운로드</h2>
      <small>현재 사업단의 사용 중인 재고품만 포함합니다.</small>
    </div></div>
    <form method="dialog">
      ${stockItems.length ? `<div class="field">
        <label for="stocktake-scope">조사표 범위</label>
        <select id="stocktake-scope">
          <option value="all">전체 재고품</option>
          <option value="daily">매일 확인 품목</option>
          <option value="monthly">월말 확인 품목</option>
        </select>
        <label for="stocktake-order">품목 정렬</label>
        <select id="stocktake-order" name="order" autofocus>
          <option value="registration">등록순</option>
          <option value="name">가나다순</option>
        </select>
        <small data-stocktake-count></small>
      </div>` : '<p>조사표에 넣을 재고품이 없습니다.</p>'}
      <div class="form-actions">
        <button class="button ghost" value="cancel">${stockItems.length ? '취소' : '닫기'}</button>
        ${stockItems.length ? '<button class="button primary" value="download">다운로드</button>' : ''}
      </div>
    </form>`;
  const scope = dialog.querySelector('#stocktake-scope');
  const selectedItems = ()=>stockItems.filter(i=>scope.value==='all' || (i.count_frequency||'monthly')===scope.value);
  if(scope){
    scope.value=initialScope;
    scope.onchange=()=>{
      const count = selectedItems().length;
      dialog.querySelector('[data-stocktake-count]').textContent=`선택한 범위의 재고품 ${count}개`;
      dialog.querySelector('[value="download"]').disabled=!count;
    };
    scope.onchange();
  }
  dialog.addEventListener('close',()=>{
    if(dialog.returnValue==='download'){
      const collator = new Intl.Collator('ko-KR',{numeric:true});
      const byName = dialog.querySelector('#stocktake-order').value==='name';
      const rows = selectedItems();
      rows.sort((a,b)=>(byName ? collator.compare(a.name,b.name) : 0) || a.id-b.id);
      if(rows.length) downloadStocktake(rows);
    }
    dialog.remove();
  },{once:true});
  target.append(dialog);
  dialog.showModal();
}

function downloadStocktake(items){
  // RTF uses signed UTF-16 code units and ASCII fallback characters.
  const escapeRtf = value=>String(value).replace(/[\\{}\n\r\t\u0080-\uffff]/g, character=>{
    if(character==='\n') return '\\line ';
    if(character==='\r') return '';
    if(character==='\t') return '\\tab ';
    const code = character.charCodeAt(0);
    return code<128 ? '\\'+character : '\\u'+(code>32767 ? code-65536 : code)+'?';
  });
  const borders = '\\clbrdrt\\brdrs\\clbrdrl\\brdrs\\clbrdrb\\brdrs\\clbrdrr\\brdrs';
  const columns = [750,5400,6900,9500].map(width=>borders+'\\cellx'+width).join('');
  const row = (cells, header=false)=>'{\\trowd\\trgaph100\\trrh380\\trkeep'+(header ? '\\trhdr' : '')+columns+' '+
    cells.map(cell=>'\\pard\\intbl '+escapeRtf(cell)+'\\cell ').join('')+'\\row}';
  const rtf = '{\\rtf1\\ansi\\uc1\\paperw11906\\paperh16838\\margl1100\\margr1100'+
    '{\\fonttbl{\\f0 Malgun Gothic;}}\\f0\\fs22'+
    '\\pard\\b\\fs32 '+escapeRtf('재고조사표')+'\\b0\\fs22\\par '+
    escapeRtf('조사일: __________________    조사자: __________________')+'\\par\\par '+
    row(['번호','품목명','실사 수량','비고'],true)+
    items.map((item,index)=>row([index+1,item.name,'',''])).join('')+'}';
  const url = URL.createObjectURL(new Blob([rtf],{type:'application/rtf'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = '재고조사표.rtf';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function editItem(id){
  const item=(window.allItems||[]).find(i=>i.id===id);if(!item)return;
  const dialog=$('#item-edit-dialog');const form=$('#item-edit-form');
  form.elements.id.value=item.id;form.elements.name.value=item.name;form.elements.item_type.value=item.item_type||'STOCK';form.elements.unit.value=item.unit;form.elements.unit_price.value=item.unit_price;form.elements.tax_type.value=item.tax_type;form.elements.min_stock.value=item.min_stock;
  $('#edit-item-caption').textContent=`현재 재고 ${qty(item.stock)} ${item.unit} · 거래 이력은 유지됩니다.`;
  dialog.showModal();setTimeout(()=>form.elements.name.focus(),0);
}
function closeItemEditor(){const dialog=$('#item-edit-dialog');if(dialog?.open)dialog.close()}
async function saveItemEdit(ev){
  ev.preventDefault();const data=Object.fromEntries(new FormData(ev.target));const id=data.id;delete data.id;
  try{await api(`/api/items/${id}`,{method:'PUT',body:JSON.stringify(data)});closeItemEditor();toast('품목 정보가 수정되었습니다.');await refresh()}catch(err){toast(err.message)}
}
async function deactivateItem(id){
  const item=(window.allItems||[]).find(i=>i.id===id);if(!item)return;
  if(!confirm(`'${item.name}' 품목을 삭제할까요?\n기존 거래 기록은 보존되며 필요하면 복구할 수 있습니다.`))return;
  try{await api(`/api/items/${id}`,{method:'DELETE'});toast('품목을 사용중지했습니다.');await refresh()}catch(err){toast(err.message)}
}
async function restoreItem(id){try{await api(`/api/items/${id}/restore`,{method:'POST',body:'{}'});toast('품목을 복구했습니다.');await refresh()}catch(err){toast(err.message)}}

async function renderMonthly(){
  const target=$('#view-monthly');
  const selected=window.monthlyDate||today().slice(0,7);
  target.innerHTML='<div class="card"><div class="card-body empty">월간 거래요약을 계산하는 중입니다...</div></div>';
  try{
    const summary=await api(`/api/monthly-summary?month=${selected}`);
    const rows=summary.rows;
    const totals=rows.reduce((a,r)=>({purchase:a.purchase+r.purchase_qty,sale:a.sale+r.sale_qty,issue:a.issue+r.issue_qty,purchaseAmount:a.purchaseAmount+r.purchase_amount,salesAmount:a.salesAmount+r.sales_amount}),{purchase:0,sale:0,issue:0,purchaseAmount:0,salesAmount:0});
    const e=(v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
    target.innerHTML=`<div class="toolbar"><div class="toolbar-left"><input type="month" id="monthly-date" value="${summary.month}"><button class="button primary" onclick="loadMonthly()">조회</button></div><div class="toolbar-right"><button class="button ghost" onclick="openPrintDialog('monthly')">인쇄</button></div></div><div class="grid kpis monthly-kpis"><div class="card kpi" data-print-key="kpiPurchase"><div class="label">월 매입</div><div class="value">${qty(totals.purchase)}<small> 건수량</small></div><div class="hint">${money(totals.purchaseAmount)}</div></div><div class="card kpi" data-print-key="kpiSale"><div class="label">월 매출</div><div class="value">${qty(totals.sale)}<small> 건수량</small></div><div class="hint">${money(totals.salesAmount)}</div></div><div class="card kpi" data-print-key="kpiIssue"><div class="label">월 불출</div><div class="value">${qty(totals.issue)}<small> 건수량</small></div><div class="hint">기관 제공 포함</div></div><div class="card kpi" data-print-key="kpiItems"><div class="label">조회 품목</div><div class="value">${qty(rows.length)}<small> 개</small></div><div class="hint">${summary.month}</div></div></div><div class="card"><div class="card-head"><div><h2>${summary.month} 월간 거래요약</h2><small>거래 원장을 기준으로 거래량·금액과 월초·월말 재고를 자동 계산합니다.</small></div></div><div class="table-wrap"><table class="data-table monthly-table"><thead><tr><th data-print-key="item">품명</th><th data-print-key="unit">단위</th><th data-print-key="opening">월초재고</th><th data-print-key="purchase">매입</th><th data-print-key="sale">매출</th><th data-print-key="issue">불출</th><th data-print-key="adjustment">조정</th><th data-print-key="closing">월말재고</th><th data-print-key="purchaseAmount">매입금액</th><th data-print-key="salesAmount">매출금액</th></tr></thead><tbody>${rows.map(r=>`<tr><td data-print-key="item"><strong>${e(r.item_name)}</strong>${r.active?'':' <span class="badge inactive">사용중지</span>'}</td><td data-print-key="unit">${e(r.unit)}</td><td data-print-key="opening">${r.item_type==='SERVICE'?'':stockDisplay(r.opening_stock)}</td><td data-print-key="purchase">${qty(r.purchase_qty)}</td><td data-print-key="sale">${qty(r.sale_qty)}</td><td data-print-key="issue">${qty(r.issue_qty)}</td><td data-print-key="adjustment">${qty(r.adjustment)}</td><td data-print-key="closing" class="${r.closing_stock<0?'danger-text':''}">${r.item_type==='SERVICE'?'':stockDisplay(r.closing_stock)}</td><td data-print-key="purchaseAmount">${money(r.purchase_amount)}</td><td data-print-key="salesAmount">${money(r.sales_amount)}</td></tr>`).join('')||'<tr><td colspan="10" class="empty">이 달의 품목이 없습니다.</td></tr>'}</tbody></table></div></div>`;
  }catch(err){target.innerHTML=`<div class="card"><div class="card-body empty">${err.message}</div></div>`}
}
async function loadMonthly(){window.monthlyDate=$('#monthly-date').value||today().slice(0,7);await renderMonthly()}

function addWelcomeSettings(target, settings) {
  target.insertAdjacentHTML('afterbegin', `
    <section class="card section">
      <div class="card-head"><div><h2>환영 페이지 설정</h2><small>모든 사업단의 접속 화면에 공통으로 적용됩니다.</small></div></div>
      <form id="welcome-settings" class="card-body">
        <div class="field"><label for="welcome-title-input">제목</label><input id="welcome-title-input" name="title" maxlength="80" required></div>
        <div class="field"><label for="welcome-message-input">안내 문구</label><textarea id="welcome-message-input" name="message" rows="3" maxlength="500" required></textarea></div>
        <div class="form-actions"><button class="button primary">환영 문구 저장</button></div>
      </form>
    </section>`);
  const form = target.querySelector('#welcome-settings');
  form.elements.title.value = settings.title;
  form.elements.message.value = settings.message;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await api('/api/admin/welcome', {
        method: 'PUT',
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      toast('환영 문구를 저장했습니다.');
    } catch (err) {
      toast(err.message);
    } finally {
      button.disabled = false;
    }
  });
}

const themeLabels = {
  teal:'청록', coffee:'커피', blue:'파랑', rose:'장미', amber:'황금', plum:'보라',
  ink:'수묵화', clear:'놀라운 깔끔함', salt:'솔트 앤 페퍼', gothic:'고딕 누아르', stone:'돌길',
};
let templateSelection = '';
let adminTab = 'overview';
let refreshNoticeAdmin = null;

function addNoticeSettings(target) {
  target.innerHTML = `<section class="card section">
    <div class="card-head"><div><h2>전체 팝업 발송</h2><small>모든 사업단에 전송합니다. 지속형은 아래 목록에 추가됩니다.</small></div></div>
    <form class="card-body">
      <div class="field"><label for="send-notice-title">제목</label><input id="send-notice-title" name="title" required maxlength="80"></div>
      <div class="field"><label for="send-notice-message">내용</label><textarea id="send-notice-message" name="message" rows="5" required maxlength="1000"></textarea></div>
      <div class="field"><label for="send-notice-mode">유형</label><select id="send-notice-mode" name="mode">
        <option value="temporary">일시형 · 지금 접속 중인 화면에 표시</option>
        <option value="persistent">지속형 · 새 접속에도 표시, 다시 보지 않음 선택 가능</option>
      </select></div>
      <div class="form-actions"><button class="button ghost" type="button" data-withdraw>일시형 내리기</button><button class="button primary">전체 발송</button></div>
      <p role="status"></p>
    </form></section>
    <section class="card section">
      <div class="card-head"><div><h2>지속형 팝업 목록</h2><small>웹과 실행기에서 발송한 지속형 공지를 개별 관리합니다.</small></div></div>
      <div class="card-body" data-notice-list></div>
    </section>`;
  const form = target.querySelector('form');
  const status = form.querySelector('[role=status]');
  const list = target.querySelector('[data-notice-list]');
  const withdraw = form.querySelector('[data-withdraw]');
  let listRequest = 0;
  refreshNoticeAdmin = async function () {
    if (!target.isConnected || target.hidden || state.view!=='admin') return;
    const request = ++listRequest;
    try {
      const {persistent} = await api('/api/admin/notice');
      if (request!==listRequest || !target.isConnected) return;
      list.innerHTML = persistent.slice().reverse().map(notice=>`
        <article class="notice-list-item" data-notice-id="${escapeHtml(notice.id)}">
          <div><h3>${escapeHtml(notice.title)}</h3><p>${escapeHtml(notice.message)}</p></div>
          <div class="quick-actions">
            <button type="button" class="button ghost" data-toggle aria-pressed="${notice.enabled}" aria-label="${escapeHtml(notice.title)} 표시">
              ${notice.enabled?'ON · 표시 중':'OFF · 숨김'}
            </button>
            <button type="button" class="button danger" data-delete>삭제</button>
          </div>
        </article>`).join('') || '<p>저장된 지속형 공지가 없습니다.</p>';
    } catch (err) {
      if (request===listRequest && target.isConnected) status.textContent = err.message;
    }
  };
  list.onclick = async event=>{
    const button = event.target.closest('button');
    if (!button) return;
    const row = button.closest('[data-notice-id]');
    const remove = button.hasAttribute('data-delete');
    if (remove && !confirm('이 지속형 공지를 목록에서 삭제할까요?')) return;
    button.disabled = true;
    try {
      await api('/api/admin/notice/'+row.dataset.noticeId, {
        method:remove?'DELETE':'PUT',
        body:JSON.stringify(remove?{}:{enabled:button.getAttribute('aria-pressed')!=='true'}),
      });
      await refreshNoticeAdmin();
    } catch (err) { status.textContent = err.message; }
    finally { button.disabled = false; }
  };
  async function change(method) {
    const buttons = [...form.querySelectorAll('button')];
    buttons.forEach(button=>{button.disabled=true});
    try {
      const result = await api('/api/admin/notice', {
        method, body:JSON.stringify(method==='POST' ? Object.fromEntries(new FormData(form)) : {}),
      });
      status.textContent = method==='POST' ? `발송 완료 · ${result.title}` : '일시형 공지를 내렸습니다.';
      if (method==='POST') form.reset();
      await refreshNoticeAdmin();
    } catch (err) { status.textContent = err.message; }
    finally { buttons.forEach(button=>{button.disabled=false}); }
  }
  form.onsubmit = event=>{event.preventDefault();change('POST')};
  withdraw.onclick = ()=>change('DELETE');
}

function addAdminData(target) {
  target.innerHTML = `<section class="card section">
    <div class="card-head"><div><h2>데이터 관리</h2><small>선택한 사업단의 품목, 거래처, 거래, 운영일지와 재고조사 내역을 백업합니다.</small></div></div>
    <div class="card-body">
      <div class="field"><label for="data-business">대상 사업단</label><select id="data-business"></select></div>
      <div class="form-actions"><button type="button" class="button ghost" data-format="sqlite">SQLite 백업 다운로드</button>
      <button type="button" class="button ghost" data-format="json">JSON 백업 다운로드</button></div>
      <div class="field"><label for="data-restore">백업 파일 불러오기</label><input id="data-restore" type="file" accept=".db,.sqlite,.sqlite3,.json"></div>
      <p>복원하면 선택한 사업단의 현재 데이터가 교체됩니다. 실행 직전에 서버가 현재 데이터를 백업합니다.</p>
      <button type="button" id="data-apply" class="button danger">선택한 파일 복원</button>
    </div></section>`;
  const select = target.querySelector('#data-business');
  for (const business of state.businesses) select.append(new Option(business.name,business.id));
  select.value = state.businessId;
  const fileInput = target.querySelector('#data-restore');
  const buttons = [...target.querySelectorAll('button')];
  const busy = value => { for (const control of [...buttons,select,fileInput]) control.disabled=value; };
  for (const button of target.querySelectorAll('[data-format]')) {
    button.onclick = async ()=>{
      const id = select.value;
      busy(true);
      try {
        const response = await fetch('/api/admin/data/backup?format='+button.dataset.format, {headers:{'X-Business-ID':id}});
        if (!response.ok) throw new Error((await response.json()).error);
        const objectUrl = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || 'inventory-backup';
        link.click();
        setTimeout(()=>URL.revokeObjectURL(objectUrl), 5000);
      } catch (err) { toast(err.message); }
      finally { busy(false); }
    };
  }
  target.querySelector('#data-apply').onclick = async ()=>{
    const business = state.businesses.find(b=>b.id===select.value);
    const file = fileInput.files[0];
    if (!business || !file) return toast('복원할 사업단과 파일을 선택해 주세요.');
    if (file.size > 32*1024*1024) return toast('32MB 이하의 백업 파일을 선택해 주세요.');
    const phrase = business.name + ' 복원';
    const confirmation = prompt(`현재 데이터를 교체합니다. 실행하려면 "${phrase}"을 입력하세요.`);
    if (confirmation !== phrase) return;
    busy(true);
    try {
      const result = await api('/api/admin/data/restore', {
        method:'POST', headers:{'X-Business-ID':business.id},
        body:JSON.stringify({confirmation, format:file.name.toLowerCase().endsWith('.json')?'json':'sqlite', data:await fileToBase64(file)}),
      });
      fileInput.value = '';
      toast('복원 완료 · 이전 데이터 백업: '+result.backup);
      if (business.id === state.businessId) await refresh(false);
    } catch (err) { toast(err.message); }
    finally { busy(false); }
  };
}

function addBusinessSettings(target, businesses) {
  target.insertAdjacentHTML('afterbegin', `
    <section class="card section">
      <div class="card-head"><div><h2>사업단과 홈 템플릿</h2><small>대표 색상과 홈에 표시할 항목을 미리보기에서 조정하세요.</small></div></div>
      <div class="card-body">
        <div class="quick-actions">
          <select id="template-business" aria-label="편집할 사업단"></select>
          <button type="button" id="template-new" class="button ghost">＋ 사업단 추가</button>
        </div>
        <form id="template-form">
          <div class="form-grid">
            <div class="field"><label for="template-name">사업단 이름</label><input id="template-name" name="name" maxlength="50" required></div>
            <div class="field"><label for="template-theme">대표 색상</label><select id="template-theme" name="theme">${Object.entries(themeLabels).map(([id,label])=>`<option value="${id}">${label}</option>`).join('')}</select></div>
          </div>
          <label class="production-setting"><input type="checkbox" name="production_enabled"> 생산·조립 기능 사용</label>
          <section id="template-preview" class="template-preview" aria-label="홈 미리보기"></section>
          <div class="form-actions">
            <button type="button" class="button danger" id="template-delete">사업단 삭제</button>
            <button class="button primary" id="template-save">저장</button>
          </div>
        </form>
      </div>
    </section>`);
  const chooser = target.querySelector('#template-business');
  const form = target.querySelector('#template-form');
  const preview = target.querySelector('#template-preview');
  const save = form.querySelector('#template-save');
  const remove = form.querySelector('#template-delete');
  chooser.append(new Option('새 사업단', ''));
  for (const b of businesses) chooser.append(new Option(b.name + (b.archived ? ' (삭제됨)' : ''), b.id));

  let draft;
  let previewData;
  let previewRequest = 0;
  function drawPreview() {
    const widgets = homeWidgets(previewData.summary, previewData.items, previewData.transactions);
    preview.dataset.theme = form.elements.theme.value;
    preview.innerHTML = `<header class="template-banner"><strong id="template-preview-name"></strong><small>홈 미리보기</small></header>
      <div class="home-grid">${Object.entries(widgets).map(([key, html])=>`
        <div class="template-widget ${['stock','recent'].includes(key)?'home-wide':''}">
          <label><input type="checkbox" data-widget="${key}" ${draft.widgets[key]?'checked':''}> ${homeWidgetLabels[key]} 표시</label>
          <div class="template-widget-content" inert ${draft.widgets[key]?'':'hidden'}>${html}</div>
        </div>`).join('')}</div>`;
    preview.querySelector('#template-preview-name').textContent = form.elements.name.value || '새 사업단';
  }

  async function select(id) {
    const request = ++previewRequest;
    templateSelection = id;
    const existing = businesses.find(b=>b.id===id);
    draft = existing ? { ...existing, widgets:{ ...existing.widgets } } : {
      id:'', name:'', theme:'teal', widgets:Object.fromEntries(Object.keys(homeWidgetLabels).map(key=>[key,true])),
    };
    chooser.value = draft.id;
    form.elements.name.value = draft.name;
    form.elements.theme.value = draft.theme;
    form.elements.production_enabled.checked = !!draft.production_enabled;
    remove.hidden = !draft.id || draft.archived;
    save.textContent = draft.archived ? '다시 활성화' : draft.id ? '변경 저장' : '사업단 생성';
    previewData = {summary:{}, items:[], transactions:[]};
    drawPreview();
    if (!draft.id || draft.archived) return;
    try {
      const options = {headers:{'X-Business-ID':draft.id}};
      const [summary, items, transactions] = await Promise.all([
        api('/api/summary', options), api('/api/items', options), api('/api/transactions', options),
      ]);
      if (request !== previewRequest || !form.isConnected) return;
      previewData = {summary, items, transactions};
      drawPreview();
    } catch (err) { if (request === previewRequest && form.isConnected) toast(err.message); }
  }

  chooser.addEventListener('change', ()=>select(chooser.value));
  target.querySelector('#template-new').addEventListener('click', async ()=>{
    await select('');
    form.elements.name.focus();
  });
  form.elements.name.addEventListener('input', ()=>{
    preview.querySelector('#template-preview-name').textContent = form.elements.name.value || '새 사업단';
  });
  form.elements.theme.addEventListener('change', ()=>{preview.dataset.theme=form.elements.theme.value});
  preview.addEventListener('change', event=>{
    const key = event.target.dataset.widget;
    if (!key) return;
    draft.widgets[key] = event.target.checked;
    event.target.closest('.template-widget').querySelector('.template-widget-content').hidden = !event.target.checked;
  });

  async function update(method, payload) {
    save.disabled = remove.disabled = chooser.disabled = true;
    try {
      const result = await api('/api/admin/businesses' + (draft.id ? '/' + draft.id : ''), {
        method, body:JSON.stringify(payload),
      });
      templateSelection = result.id;
      state.businesses = await api('/api/businesses');
      if (!isBusiness(state.businessId)) {
        if (localStorage.getItem(rememberedBusinessKey) === state.businessId) localStorage.removeItem(rememberedBusinessKey);
        await enterBusiness(state.businesses[0].id, 'admin');
      } else {
        applyBusinessTheme();
        await renderAdmin();
      }
      toast(method==='DELETE' ? '사업단을 목록에서 삭제했습니다.' : '사업단 설정을 저장했습니다.');
    } catch (err) { toast(err.message); }
    finally { save.disabled = remove.disabled = chooser.disabled = false; }
  }

  form.addEventListener('submit', event=>{
    event.preventDefault();
    update(draft.id?'PUT':'POST', {
      name:form.elements.name.value, theme:form.elements.theme.value, widgets:draft.widgets,
      production_enabled:form.elements.production_enabled.checked,
    });
  });
  remove.addEventListener('click', ()=>{
    const phrase = draft.name + ' 삭제';
    const confirmation = prompt(`접속 목록에서 사업단을 제거합니다. 기존 데이터는 유지되며 다시 활성화할 수 있습니다. 실행하려면 "${phrase}"를 입력하세요.`);
    if (confirmation === phrase) update('DELETE', {confirmation});
  });
  select(templateSelection || state.businessId);
}

async function renderAdmin(){
  var target=$('#view-admin');
  if(!state.admin){
    target.innerHTML='<div class="card admin-login"><div class="card-head"><div><h2>관리자 인증</h2><small>전체 사업단 요약과 초기화 기능은 관리자만 볼 수 있습니다.</small></div></div><form id="admin-login-form" class="card-body"><div class="field"><label>관리자 코드</label><input name="code" type="password" autocomplete="current-password" required></div><div class="form-actions"><button class="button primary">관리자 페이지 열기</button></div></form></div>';
    $('#admin-login-form').addEventListener('submit',async function(e){e.preventDefault();try{await api('/api/admin/login',{method:'POST',body:JSON.stringify({code:new FormData(e.target).get('code')})});state.admin=true;toast('관리자 인증되었습니다.');setView('admin')}catch(err){toast(err.message)}});
    return;
  }
  var start=today().slice(0,8)+'01';
  target.innerHTML='<div class="card"><div class="card-body empty">전체 사업단 요약을 불러오는 중입니다...</div></div>';
  try{
    const [summary, welcomeSettings, adminItems, businesses] = await Promise.all([
      api('/api/admin/summary?from='+start+'&to='+today()),
      api('/api/welcome'),
      api('/api/items?all=1'),
      api('/api/admin/businesses'),
    ]);
    var cards=summary.businesses.map(function(b){return '<div class="card admin-business-card" data-theme="'+b.theme+'"><div class="card-head"><div><h2>'+escapeHtml(b.name)+'</h2><small>매출 '+money(b.sales_amount)+' · 품목 '+qty(b.item_count)+'개</small></div><button class="button danger" onclick="resetBusiness(\''+b.id+'\')">이 사업단 초기화</button></div><div class="card-body"><div class="admin-stock-columns"><div><strong>부족 재고 '+b.low_stock.length+'개</strong>'+(b.low_stock.length?b.low_stock.map(function(i){return '<div class="stock-sub"><span class="danger-text">'+escapeHtml(i.name)+'</span> · '+qty(i.stock)+' '+escapeHtml(i.unit)+'</div>'}).join(''):'<div class="stock-sub">없음</div>')+'</div><div><strong>재고 없음 '+b.out_of_stock.length+'개</strong>'+(b.out_of_stock.length?b.out_of_stock.map(function(i){return '<div class="stock-sub"><span class="danger-text">'+escapeHtml(i.name)+'</span> · 0 '+escapeHtml(i.unit)+'</div>'}).join(''):'<div class="stock-sub">없음</div>')+'</div></div></div></div>'}).join('');
    window.adminItems=adminItems;
    var items=adminItems.map(function(i){return '<tr><td><strong>'+escapeHtml(i.name)+'</strong>'+(i.active?'':' <span class="badge inactive">사용중지</span>')+'</td><td>'+qty(i.stock)+' '+escapeHtml(i.unit)+'</td><td><button class="button danger" onclick="hardDeleteItem('+i.id+')">완전삭제</button></td></tr>'}).join('');
    var current=state.businesses.find(function(x){return x.id===state.businessId});
    target.innerHTML='<div class="card section"><div class="card-head"><div><h2>전체 사업단 관리자 대시보드</h2><small>'+summary.from+' ~ '+summary.to+' 매출·재고 요약</small></div><button class="button ghost" onclick="adminLogout()">로그아웃</button></div><div class="card-body"><div class="ledger-summary"><div><span>전체 매출</span><strong>'+money(summary.sales_amount)+'</strong></div><div><span>재고 부족</span><strong class="danger-text">'+qty(summary.low_count)+'개</strong></div><div><span>재고 없음</span><strong class="danger-text">'+qty(summary.out_count)+'개</strong></div><div><span>사업단</span><strong>'+qty(summary.businesses.length)+'곳</strong></div></div></div></div><div class="admin-business-grid">'+cards+'</div><div class="card section"><div class="card-head"><div><h2>'+escapeHtml(current.name)+' 품목 완전삭제</h2><small>거래 이력과 운영일지 메모까지 함께 삭제됩니다. 삭제 전 자동 백업합니다.</small></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>품목</th><th>현재재고</th><th>관리</th></tr></thead><tbody>'+items+'</tbody></table></div></div>';
    const overview = document.createElement('section');
    overview.append(...target.childNodes);
    target.innerHTML = `<nav class="subnav" aria-label="관리자 메뉴">
      <button class="tab" data-admin-tab="overview">전체 요약</button>
      <button class="tab" data-admin-tab="businesses">사업단·홈 설정</button>
      <button class="tab" data-admin-tab="data">데이터 관리</button>
      <button class="tab" data-admin-tab="notice">전체 팝업 발송</button>
      <button class="tab" data-admin-tab="welcome">환영 페이지</button>
    </nav>`;
    const panels = {overview, businesses:document.createElement('section'), data:document.createElement('section'), notice:document.createElement('section'), welcome:document.createElement('section')};
    target.append(...Object.values(panels));
    addWelcomeSettings(panels.welcome, welcomeSettings);
    addBusinessSettings(panels.businesses, businesses);
    addAdminData(panels.data);
    addNoticeSettings(panels.notice);
    const tabs = target.querySelectorAll('[data-admin-tab]');
    function selectTab(key) {
      adminTab = key;
      Object.entries(panels).forEach(([name,panel])=>{panel.hidden=name!==key});
      tabs.forEach(tab=>tab.classList.toggle('active',tab.dataset.adminTab===key));
      if (key==='notice') refreshNoticeAdmin?.();
    }
    tabs.forEach(tab=>tab.onclick=()=>selectTab(tab.dataset.adminTab));
    selectTab(adminTab);
  }catch(err){if(/인증/.test(err.message)){state.admin=false;renderAdmin()}else target.innerHTML='<div class="card"><div class="card-body empty">'+escapeHtml(err.message)+'</div></div>'}
}
async function adminLogout(){try{await api('/api/admin/logout',{method:'POST',body:'{}'})}finally{state.admin=false;setView('dashboard')}}
async function resetBusiness(id){var b=state.businesses.find(function(x){return x.id===id});if(!b)return;if(!confirm(b.name+'의 모든 품목·거래·운영일지를 초기화할까요?'))return;var typed=prompt("실행하려면 '"+b.name+" 초기화'를 입력하세요.");if(typed!==b.name+' 초기화')return toast('초기화를 취소했습니다.');try{await api('/api/admin/reset-business',{method:'POST',body:JSON.stringify({business_id:id,confirmation:typed})});toast(b.name+' 초기화 완료');if(id===state.businessId)await refresh();else renderAdmin()}catch(err){toast(err.message)}}
async function hardDeleteItem(id){var item=(window.itemManagementItems||window.adminItems||state.items).find(function(x){return x.id===id});if(!item)return;if(!confirm("'"+item.name+"'을(를) 완전삭제할까요? 거래 이력도 모두 삭제됩니다."))return;var typed=prompt("실행하려면 '완전삭제'를 입력하세요.");if(typed!=='완전삭제')return toast('완전삭제를 취소했습니다.');try{await api('/api/admin/hard-delete-item',{method:'POST',body:JSON.stringify({item_id:id,confirmation:typed})});toast('품목을 완전삭제했습니다.');await refresh();if(state.view==='admin')renderAdmin();else renderItems()}catch(err){toast(err.message)}}

async function handleWorkbookUpload(file){
  if(!file)return;
  window.lastImportResult=null;window.lastImportError='';
  if(!file.name.toLowerCase().endsWith('.xlsx')){window.lastImportError=file.name.toLowerCase().endsWith('.xls')?'구형 .xls 파일은 엑셀에서 .xlsx 형식으로 저장한 뒤 다시 올려주세요.':'엑셀 .xlsx 형식의 파일만 올릴 수 있습니다.';return renderImport()}
  if(file.size>20*1024*1024){window.lastImportError='20MB 이하의 엑셀 파일만 올릴 수 있습니다.';return renderImport()}
  window.importing=true;renderImport();
  try{
    const result=await api('/api/import-workbook',{method:'POST',body:JSON.stringify({filename:file.name,data:await fileToBase64(file)})});
    window.lastImportResult=result;window.lastImportError='';window.dailyDate=result.validation.date_to;dailyQuery=null;
    toast('엑셀 검증과 자동 반영이 완료되었습니다.');
    await refresh();
  }catch(err){window.lastImportError=err.message;toast('검증에 실패해 반영하지 않았습니다.');renderImport()}
  finally{window.importing=false;renderImport()}
}

const escapeHtml=(v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
function transactionTable(rows){
  if(!rows.length)return '<div class="empty">조건에 맞는 거래가 없습니다.</div>';
  return `<table class="data-table transaction-table"><thead><tr><th>일자</th><th>구분</th><th>품목</th><th>기관·거래처</th><th>수량</th><th>단가</th><th>금액</th><th>비고</th><th>입력</th><th></th></tr></thead><tbody>${rows.map(t=>`<tr><td>${t.transaction_date}</td><td><span class="badge ${t.transaction_type.toLowerCase().replace('_in','').replace('_out','')}">${escapeHtml(transactionLabel(t))}</span></td><td><strong>${escapeHtml(t.item_name)}</strong></td><td>${escapeHtml(t.partner_name||'-')}</td><td>${qty(t.quantity)} ${escapeHtml(t.unit)}</td><td>${money(t.unit_price)}</td><td>${money(t.quantity*t.unit_price)}</td><td class="note-cell">${escapeHtml(t.note||'')}</td><td><span class="badge ${t.source==='excel'?'inactive':'purchase'}">${t.source==='excel'?'엑셀':managedMovement(t)?transactionLabel(t):'직접'}</span></td><td>${managedMovement(t)?'<span class="stock-sub">연결 기록</span>':t.source==='excel'?'<span class="stock-sub">원본 관리</span>':`<button class="button danger" onclick="removeTx(${t.id})">삭제</button>`}</td></tr>`).join('')}</tbody></table>`;
}

let dailyQuery = null;
let dailyShowDelta = false;
let dailyMode = 'summary';
const dailyTransactionColumns = [
  ['no','순번'], ['date','거래일'], ['type','구분'], ['item','품명'], ['partner','기관·거래처'],
  ['unit','단위'], ['quantity','수량'], ['unitPrice','단가'], ['amount','거래금액'], ['note','비고'],
];
let calendarMonth = null;

function moveMonth(month, offset) {
  const [year, number] = month.split('-').map(Number);
  const moved = new Date(year, number - 1 + offset, 1);
  return `${moved.getFullYear()}-${String(moved.getMonth()+1).padStart(2,'0')}`;
}

function monthCalendar(month, renderDay, selection=null) {
  const [year, number] = month.split('-').map(Number);
  const start = new Date(year, number - 1, 1).getDay();
  const length = new Date(year, number, 0).getDate();
  const cells = Array.from({length: Math.ceil((start+length)/7)*7}, (_, index)=>{
    const day = index - start + 1;
    if (day<1 || day>length) return '<span class="calendar-blank" aria-hidden="true"></span>';
    const date = `${month}-${String(day).padStart(2,'0')}`;
    const selected = selection && selection.from<=date && date<=selection.to;
    const edge = selected && (date===selection.from || date===selection.to);
    return `<button type="button" data-calendar-day="${date}" class="calendar-day${selected?' in-range':''}${edge?' range-edge':''}"
      ${selection?`aria-pressed="${!!selected}"`:''} ${date===today()?'aria-current="date"':''}>
      <time datetime="${date}" aria-label="${date}">${day}</time>${renderDay(date)}
    </button>`;
  }).join('');
  return `<div class="calendar-controls">
    <button type="button" class="button ghost" data-month-step="-1" aria-label="이전 달">‹</button>
    <strong>${year}년 ${number}월</strong>
    <button type="button" class="button ghost" data-month-step="1" aria-label="다음 달">›</button>
    <button type="button" class="button ghost" data-month-step="0">이번 달</button>
  </div><div class="calendar-week">${[...'일월화수목금토'].map(day=>`<span>${day}</span>`).join('')}</div>
  <div class="calendar-grid">${cells}</div>`;
}

function mountRangeCalendar(form, query) {
  const picker = form.querySelector('.daily-range-picker');
  const calendar = picker.querySelector('.range-calendar');
  let month = query.from.slice(0,7);
  let anchor = null;
  function draw() {
    const selection = anchor ? {from:anchor, to:anchor} : query;
    calendar.innerHTML = monthCalendar(month, ()=>'', selection)
      + `<p class="calendar-hint" aria-live="polite">${anchor ? `${anchor} 선택됨. 종료일을 누르세요.` : '시작일과 종료일을 차례로 누르세요. 같은 날을 두 번 누르면 하루를 조회합니다.'}</p>`;
  }
  picker.addEventListener('toggle', ()=>{
    if (!picker.open) { anchor = null; return; }
    draw();
  });
  picker.addEventListener('keydown', event=>{
    if (event.key!=='Escape' || !picker.open) return;
    event.preventDefault();
    picker.open = false;
    picker.querySelector('summary').focus();
  });
  calendar.addEventListener('click', event=>{
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-month-step')) {
      const step = Number(button.dataset.monthStep);
      month = step ? moveMonth(month, step) : today().slice(0,7);
      draw();
      calendar.querySelector(`[data-month-step="${step}"]`)?.focus();
      return;
    }
    const day = button.dataset.calendarDay;
    if (!day) return;
    if (!anchor) {
      anchor = day;
      draw();
      calendar.querySelector(`[data-calendar-day="${day}"]`)?.focus();
      return;
    }
    const [from, to] = [anchor, day].sort();
    form.elements.from.value = from;
    form.elements.to.value = to;
    picker.open = false;
    form.requestSubmit();
  });
}

function calendarAmounts(units, direction) {
  const sign = direction==='in' ? '+' : '−';
  return Object.entries(units).filter(([, movement])=>movement[direction])
    .map(([unit, movement])=>`${sign}${qty(movement[direction])} ${escapeHtml(unit)}`);
}

async function renderCalendar(){
  const target = $('#view-calendar');
  const business = state.businessId;
  const month = calendarMonth || today().slice(0,7);
  target.innerHTML = '<div class="card empty">달력 대장을 불러오는 중입니다…</div>';
  const loading = target.firstElementChild;
  try {
    const data = await api(`/api/calendar-summary?month=${encodeURIComponent(month)}`);
    if (!loading.isConnected || business!==state.businessId) return;
    const totals = data.totals;
    const summary = [
      ['입고', calendarAmounts(totals.units,'in').join(' · ') || '—'],
      ['출고', calendarAmounts(totals.units,'out').join(' · ') || '—'],
      ['매출금액', money(totals.sales_amount)], ['거래', `${qty(totals.entries)}건`],
    ];
    const grid = monthCalendar(month, date=>{
      const day = data.days[date];
      if (!day) return '';
      const inbound = calendarAmounts(day.units,'in');
      const outbound = calendarAmounts(day.units,'out');
      const movement = [...inbound.map(value=>`<span class="calendar-in">${value}</span>`),
        ...outbound.map(value=>`<span class="calendar-out">${value}</span>`)].join('');
      return `<span class="calendar-movements">${movement || (day.sales_amount ? `<small>매출 ${money(day.sales_amount)}</small>` : '')}</span><small>${qty(day.entries)}건</small>`;
    });
    target.innerHTML = `<div class="card calendar-ledger">
      <div class="calendar-stats"><h2>${month===today().slice(0,7)?'이번 달 통계':'선택한 달 통계'}</h2>
        ${summary.map(([label,value])=>`<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>
      ${grid}<p class="calendar-hint">입고는 +, 출고는 −로 표시합니다. 반품과 재고 조정도 포함하며, 날짜를 누르면 그날의 운영일지가 열립니다.</p></div>`;
    target.querySelector('.calendar-ledger').addEventListener('click', event=>{
      const button = event.target.closest('button');
      if (!button) return;
      if (button.hasAttribute('data-month-step')) {
        const step = Number(button.dataset.monthStep);
        calendarMonth = step ? moveMonth(month, step) : today().slice(0,7);
        renderCalendar();
      } else if (button.dataset.calendarDay) {
        const day = button.dataset.calendarDay;
        dailyQuery = {business, from:day, to:day, partner_id:''};
        setView('daily');
      }
    });
  } catch (err) {
    if (loading.isConnected) loading.textContent = err.message;
  }
}

async function renderDaily(){
  const target = $('#view-daily');
  const selected = window.dailyDate || today();
  const business = state.businessId;
  if (dailyQuery?.business !== business) {
    dailyQuery = {business, from:selected, to:selected, partner_id:''};
  }
  const query = dailyQuery;
  const detail = dailyMode==='transactions';
  let options = detail ? dailyTransactionColumns : printOptions.daily;
  target.innerHTML = `<nav class="subnav print-hide" aria-label="일일 운영일지 보기">
      <button type="button" class="tab ${detail?'':'active'}" data-daily-mode="summary" aria-pressed="${!detail}">간단히 보기</button>
      <button type="button" class="tab ${detail?'active':''}" data-daily-mode="transactions" aria-pressed="${detail}">나열하기</button>
    </nav><div class="toolbar print-hide">
    <form id="daily-filter" class="toolbar-left daily-filters">
      <input type="hidden" name="from" value="${escapeHtml(query.from)}">
      <input type="hidden" name="to" value="${escapeHtml(query.to)}">
      <div class="field"><span class="daily-range-label">조회 기간</span>
        <details class="daily-range-picker">
          <summary class="button ghost" aria-label="조회 기간 달력">${escapeHtml(query.from===query.to?query.from:`${query.from} ~ ${query.to}`)}</summary>
          <div class="range-calendar"></div>
        </details></div>
      <label class="field">기관·거래처<select name="partner_id"><option value="">전체</option>
        ${state.partners.map(p=>`<option value="${p.id}" ${String(p.id)===query.partner_id?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}
      </select></label>
      <button class="button primary">조회</button>
    </form>
    <div class="toolbar-right">
      ${detail?'':`<label class="daily-delta-option"><input id="daily-show-delta" type="checkbox" ${dailyShowDelta?'checked':''}> 전일 대비 증감</label>`}
      <button id="daily-print" class="button ghost" disabled>PDF/인쇄</button>
    </div></div>
    <div id="daily-result"><div class="card empty">일일 운영일지를 불러오는 중입니다…</div></div>`;
  const form = target.querySelector('#daily-filter');
  const output = target.querySelector('#daily-result');
  const print = target.querySelector('#daily-print');
  mountRangeCalendar(form, query);
  target.querySelectorAll('[data-daily-mode]').forEach(button=>button.onclick=()=>{
    if (dailyMode===button.dataset.dailyMode) return;
    dailyMode = button.dataset.dailyMode;
    dailyQuery = {...Object.fromEntries(new FormData(form)), business};
    renderDaily();
  });
  form.addEventListener('submit', event=>{
    event.preventDefault();
    const filters = Object.fromEntries(new FormData(form));
    if (filters.from > filters.to) return toast('시작일은 종료일보다 늦을 수 없습니다.');
    dailyQuery = {...filters, business};
    renderDaily();
  });
  target.querySelector('#daily-show-delta')?.addEventListener('change', event=>{
    dailyShowDelta = event.target.checked;
    output.classList.toggle('daily-hide-delta', !dailyShowDelta);
  });
  print.onclick = ()=>openPrintDialog('daily', options);
  try {
    const params = new URLSearchParams({from:query.from, to:query.to});
    if (query.partner_id) params.set('partner_id',query.partner_id);
    if (detail) params.set('mode','transactions');
    const sheet = await api(`/api/daily-sheet?${params}`);
    if (!output.isConnected || business!==state.businessId) return;
    if (detail && sheet.mode!=='transactions') throw new Error('나열하기를 사용하려면 서버를 재시작해 주세요.');
    if (!detail && sheet.rows.some(row=>row.production_in_qty || row.production_out_qty)) {
      options = [...options, ['productionIn','생산 입고'], ['productionOut','생산 출고']];
    }
    const single = sheet.from===sheet.to;
    const period = single ? sheet.to : `${sheet.from} ~ ${sheet.to}`;
    const title = `${escapeHtml(period)} ${detail?'거래별 내역':'매입·매출 관리 현황'}`;
    const description = detail ? `기관·거래처 ${escapeHtml(sheet.partner||'전체')} · 거래 한 건당 한 줄` : sheet.partner
      ? `기관·거래처 ${escapeHtml(sheet.partner)} · 거래는 선택한 기관 기준, 재고는 사업단 전체 기준`
      : '기관·거래처 전체 · 재고 및 거래 내역';
    const deltaNote = '전일 대비 증감은 종료일 재고에서 종료일 전날 재고를 뺀 값입니다.';
    const headers = options.map(([key,label])=>{
      if (single && key==='opening') label='전일재고';
      if (single && key==='closing') label='금일재고';
      return `<th scope="col" data-print-key="${key}">${label}</th>`;
    }).join('');
    const cells = sheet.rows.map((row,index)=>{
      const stock = value=>row.item_type==='SERVICE'?'':stockDisplay(value);
      const delta = row.stock_delta;
      const values = detail ? [
        index+1, escapeHtml(row.transaction_date), escapeHtml(transactionLabel(row)),
        `<strong>${escapeHtml(row.item_name)}</strong>`, escapeHtml(row.partner_name||'—'),
        escapeHtml(row.unit), qty(row.quantity), money(row.unit_price),
        money(row.quantity*row.unit_price), escapeHtml(row.note),
      ] : [
        row.no, `<strong>${escapeHtml(row.item_name)}</strong>`, escapeHtml(row.unit),
        money(row.unit_price), escapeHtml(row.tax_type), stock(row.opening_stock),
        qty(row.purchase_qty), row.other_in_qty==null?'':qty(row.other_in_qty),
        qty(row.sale_qty), row.other_out_qty==null?'':qty(row.other_out_qty), stock(row.closing_stock),
        delta==null?'':`${delta>0?'+':''}${qty(delta)}`,
        money(row.sales_amount), escapeHtml(row.note),
        row.production_in_qty==null?'':qty(row.production_in_qty),
        row.production_out_qty==null?'':qty(row.production_out_qty),
      ];
      return `<tr>${options.map(([key],i)=>`<td data-print-key="${key}">${values[i]}</td>`).join('')}</tr>`;
    }).join('');
    const columns = options.length;
    const count = detail ? `거래 ${sheet.rows.length}건` : `품목 ${sheet.rows.length}개`;
    output.classList.toggle('daily-hide-delta', !dailyShowDelta);
    output.innerHTML = `<div class="daily-printable card">
      <div class="card-head print-hide"><div><h2>${title}</h2><small>${description}</small>
        ${detail?'':`<small class="daily-delta-help">재고 조정과 반품 수량은 조정·반품 입고 및 출고 열에 표시됩니다.</small><small class="daily-delta-help" data-print-key="delta">${deltaNote}</small>`}</div>
        <span class="badge purchase">${count}</span></div>
      <div class="table-wrap"><table class="data-table daily-table">
        <thead><tr class="daily-print-heading"><td colspan="${columns}" data-print-span><h2>${title}</h2>
          <div>${description} · ${count}</div>
          ${detail?'':`<div data-print-key="delta">${deltaNote}</div>`}</td></tr><tr>${headers}</tr></thead>
        <tbody>${cells||`<tr><td colspan="${columns}" data-print-span class="empty">${detail?'조회 조건에 맞는 거래가 없습니다.':'표시할 품목이 없습니다.'}</td></tr>`}</tbody>
        <tfoot class="daily-print-spacer"><tr><td colspan="${columns}" data-print-span></td></tr></tfoot>
      </table></div></div>`;
    print.disabled = false;
  } catch(err) {
    if (output.isConnected) output.innerHTML = `<div class="card empty">${escapeHtml(err.message)}</div>`;
  }
}

function openTransactionDialog() {
  const dialog = $('#transaction-dialog');
  if (dialog.open) return;
  renderEntry();
  const entry = $('#view-entry');
  dialog.replaceChildren(entry.firstElementChild);
  dialog.insertAdjacentHTML('afterbegin','<div class="dialog-actions"><button class="dialog-close" type="button" aria-label="닫기">×</button></div>');
  dialog.querySelector('.dialog-close').onclick = ()=>dialog.close();
  entry.replaceChildren();
  dialog.showModal();
}
$('#transaction-dialog').addEventListener('close', event=>event.target.replaceChildren());

function setLedgerPeriod(period) {
  const form = $('#ledger-filter-form');
  const range = defaultLedgerFilters();
  form.elements.from.value = period==='today' ? range.to : range.from;
  form.elements.to.value = range.to;
  loadLedger();
}

function defaultLedgerFilters(){const d=new Date();return {from:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`,to:today(),item_id:'',partner_id:'',type:'',q:''}}
function renderLedger(){
  const f=window.ledgerFilters||defaultLedgerFilters();window.ledgerFilters=f;
  const itemOptions=state.items.map(i=>`<option value="${i.id}" ${String(i.id)===String(f.item_id)?'selected':''}>${escapeHtml(i.name)}</option>`).join('');
  const partnerOptions=state.partners.map(p=>`<option value="${p.id}" ${String(p.id)===String(f.partner_id)?'selected':''}>${escapeHtml(p.name)}</option>`).join('');
  $('#view-ledger').innerHTML=`<div class="card section">
    <div class="card-head"><h2>거래 검색</h2><div class="quick-actions">
      ${productionEnabled()?'<button class="button ghost" onclick="setView(\'production\')">완성품 만들기</button>':''}
      <button class="button primary" onclick="openTransactionDialog()">＋ 거래 입력</button></div></div>
    <form id="ledger-filter-form" class="card-body">
      <div class="quick-actions ledger-quick">
        <button type="button" class="button ghost" onclick="setLedgerPeriod('today')">오늘</button>
        <button type="button" class="button ghost" onclick="setLedgerPeriod('month')">이번 달</button>
        <input aria-label="통합 검색" type="search" name="q" value="${escapeHtml(f.q)}" placeholder="품목·거래처·비고 검색">
        <button class="button primary">조회</button>
      </div>
      <details class="ledger-details" ${window.ledgerDetailsOpen?'open':''}><summary>상세 검색 <small>${escapeHtml(f.from)} ~ ${escapeHtml(f.to)}</small></summary><div class="filter-grid"><div class="field"><label>시작일</label><input type="date" name="from" value="${f.from}"></div><div class="field"><label>종료일</label><input type="date" name="to" value="${f.to}"></div><div class="field"><label>품목</label><select name="item_id"><option value="">전체 품목</option>${itemOptions}</select></div><div class="field"><label>기관·거래처</label><select name="partner_id"><option value="">전체 거래처</option>${partnerOptions}</select></div><div class="field"><label>거래유형</label><select name="type"><option value="">전체 유형</option>${Object.entries(labels).map(([value,label])=>`<option value="${value}" ${value===f.type?'selected':''}>${label}</option>`).join('')}</select></div></div><div class="form-actions"><button type="button" class="button ghost" onclick="clearLedgerFilters()">조건 초기화</button></div></details>
    </form></div><div id="ledger-results"><div class="card"><div class="card-body empty">거래를 조회하는 중입니다...</div></div></div>`;
  $('.ledger-details').addEventListener('toggle',event=>{window.ledgerDetailsOpen=event.target.open});
  $('#ledger-filter-form').addEventListener('submit',ev=>{ev.preventDefault();loadLedger()});
  setTimeout(()=>loadLedger(false),0);
}
async function loadLedger(readForm=true){
  if(readForm){const form=$('#ledger-filter-form');if(!form)return;window.ledgerFilters=Object.fromEntries(new FormData(form));form.querySelector('summary small').textContent=window.ledgerFilters.from+' ~ '+window.ledgerFilters.to}
  const f=window.ledgerFilters||defaultLedgerFilters();
  if(f.from&&f.to&&f.from>f.to){toast('시작일은 종료일보다 늦을 수 없습니다.');return}
  const params=new URLSearchParams();Object.entries(f).forEach(([key,value])=>{if(value)params.set(key,value)});
  try{const rows=await api(`/api/transactions?${params}`);window.ledgerRows=rows;renderLedgerResults(rows)}catch(err){$('#ledger-results').innerHTML=`<div class="card"><div class="card-body empty">${escapeHtml(err.message)}</div></div>`}
}
function renderLedgerResults(rows){
  const inbound=rows.filter(r=>['PURCHASE','RETURN_IN','ADJUST_IN'].includes(r.transaction_type)).reduce((a,r)=>a+Number(r.quantity),0);
  const outbound=rows.filter(r=>['SALE','ISSUE','RETURN_OUT','ADJUST_OUT'].includes(r.transaction_type)).reduce((a,r)=>a+Number(r.quantity),0);
  const amount=rows.reduce((a,r)=>a+Number(r.quantity)*Number(r.unit_price),0);
  $('#ledger-results').innerHTML=`<div class="ledger-summary"><div><span>검색 결과</span><strong>${qty(rows.length)}건</strong></div><div><span>입고 수량</span><strong>${qty(inbound)}</strong></div><div><span>출고 수량</span><strong>${qty(outbound)}</strong></div><div><span>거래금액</span><strong>${money(amount)}</strong></div></div><div class="card"><div class="card-head"><h2>거래 장부</h2><small>최신 거래 순</small></div><div class="table-wrap">${transactionTable(rows)}</div></div>`;
}
function clearLedgerFilters(){window.ledgerFilters=defaultLedgerFilters();renderLedger()}

async function renderImport(){
  const target=$('#view-import');const result=window.lastImportResult;const error=window.lastImportError;
  const status=window.importing?`<div class="import-result loading">파일 구조와 재고 계산을 검증한 뒤 자동 반영하고 있습니다...</div>`:error?`<div class="import-result failed"><strong>반영하지 않았습니다.</strong><br>${escapeHtml(error)}</div>`:result?`<div class="import-result passed"><strong>검증 통과 · 자동 반영 완료</strong><div class="import-summary"><span>반영 유형 <b>${result.validation.mode==='snapshot'?'재고조사':'거래·재고'}</b></span><span>기간 <b>${result.validation.date_from} ~ ${result.validation.date_to}</b></span><span>날짜 시트 <b>${qty(result.validation.daily_sheets)}개</b></span><span>품목 <b>${qty(result.items)}개</b></span><span>재고 행 <b>${qty(result.rows)}행</b></span><span>매입 <b>${qty(result.validation.purchase_qty)}</b></span><span>매출 <b>${qty(result.validation.sale_qty)}</b></span><span>재고조사 <b>${qty(result.snapshots||0)}행</b></span></div>${result.validation.warnings.length?`<div class="import-warnings">${result.validation.warnings.map(w=>`• ${escapeHtml(w)}`).join('<br>')}</div>`:''}<div class="form-actions"><button class="button primary" onclick="window.dailyDate='${result.validation.date_to}';dailyQuery=null;setView('daily')">반영 결과 보기</button></div></div>`:'';
  target.innerHTML=`<div class="card import-only"><div class="card-head"><div><h2>원본 엑셀 자동 반영</h2><small>거래 양식과 재고조사 양식을 자동 판별해 반영합니다.</small></div></div><div class="card-body"><div class="import-notice">전일·금일재고가 있는 거래 양식은 재고 계산을 검증하고, 재고·수량만 있는 표는 재고조사로 저장합니다. 날짜가 없는 날은 0이 아닌 미조사로 남깁니다.</div><label class="upload-zone ${window.importing?'disabled':''}"><input id="workbook-file" type="file" accept=".xlsx,.xls" ${window.importing?'disabled':''}><strong>${window.importing?'검증 중입니다':'엑셀 파일 선택'}</strong><span>현재는 .xlsx 자동 인식을 지원합니다. .xls는 .xlsx로 저장 후 선택하세요.</span></label>${status}</div></div>`;
  const input=$('#workbook-file');if(input)input.addEventListener('change',()=>handleWorkbookUpload(input.files[0]));
}



const noticeDialog = $('#notice-dialog');
const dismissedNoticeKey = 'inventoryDismissedNotice';
const closedNoticeIds = new Set();
let currentNotice = null;
let activePersistent = [];
let activeTemporary = null;

function showNextNotice() {
  const eligible = [activeTemporary, ...activePersistent].filter(notice => notice
    && !closedNoticeIds.has(notice.id)
    && (notice.mode!=='persistent' || (localStorage.getItem(dismissedNoticeKey)!==notice.id
      && localStorage.getItem(`${dismissedNoticeKey}:${notice.id}`)!=='1')));
  const next = eligible.find(notice=>notice.id===currentNotice?.id) || eligible[0];
  if (!next) {
    currentNotice = null;
    if (noticeDialog.open) noticeDialog.close();
    return;
  }
  if (currentNotice?.id===next.id && noticeDialog.open) return;
  currentNotice = next;
  $('#notice-title').textContent = next.title;
  $('#notice-message').textContent = next.message;
  $('#notice-hide').checked = false;
  $('#notice-hide-option').hidden = next.mode!=='persistent';
  if (!noticeDialog.open) noticeDialog.showModal();
}

function closeNotice() {
  if (!currentNotice) return;
  closedNoticeIds.add(currentNotice.id);
  if (currentNotice.mode==='persistent' && $('#notice-hide').checked) {
    localStorage.setItem(`${dismissedNoticeKey}:${currentNotice.id}`,'1');
  }
  showNextNotice();
}
noticeDialog.querySelector('.dialog-close').onclick = closeNotice;
$('#notice-confirm').onclick = closeNotice;
noticeDialog.addEventListener('cancel', event=>{event.preventDefault();closeNotice()});
window.addEventListener('storage', event=>{
  if (event.key?.startsWith(dismissedNoticeKey)) showNextNotice();
});
const noticeStream = new EventSource('/api/notice/events?v=2');
noticeStream.onmessage = event=>{
  const update = JSON.parse(event.data);
  activePersistent = update.persistent;
  if (Object.hasOwn(update,'temporary')) activeTemporary = update.temporary;
  const visibleIds = new Set([activeTemporary, ...activePersistent].filter(Boolean).map(notice=>notice.id));
  for (const id of closedNoticeIds) if (!visibleIds.has(id)) closedNoticeIds.delete(id);
  showNextNotice();
  if (adminTab==='notice') refreshNoticeAdmin?.();
};
