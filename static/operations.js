const operationTitles = {counts:'재고 실사',work:'작업일지',cafe:'카페 레시피',planning:'발주·생산능력'};
const operationSettings = new Map();

function operationOptions(items, selected) {
  return items.map(i=>`<option value="${i.id}" ${i.id===selected?'selected':''}>${escapeHtml(i.name)} (${escapeHtml(i.unit)})</option>`).join('');
}

function operationTable(headers, rows, empty) {
  return rows.length ? `<div class="table-wrap"><table class="data-table"><thead><tr>${headers.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p class="operation-note">${empty}</p>`;
}

function operationCard(title, hint, content) {
  return `<section class="card section operation-card"><div class="card-head"><div><h2>${title}</h2><small>${hint}</small></div></div>
    <div class="card-body"><p class="operation-error" role="alert" tabindex="-1" hidden></p>${content}</div></section>`;
}

async function renderOperations(view) {
  const business = state.businessId;
  const target = $(`#view-${view}`);
  target.innerHTML = '<div class="card empty">불러오는 중입니다…</div>';
  const loading = target.firstElementChild;
  if (!operationSettings.has(business)) operationSettings.set(business, {
    scope:'daily',date:today(),countMonth:today().slice(0,7),workMonth:today().slice(0,7),capacityMonth:today().slice(0,7),
  });
  const settings = operationSettings.get(business);
  const current = ()=>state.businessId===business && state.view===view;
  const active = ()=>loading.isConnected && current();
  const request = (name, params={}, body)=>api(`/api/operations/${name}?${new URLSearchParams(params)}`,{
    headers:{'X-Business-ID':business},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
  });
  async function save(control, name, body, message) {
    const error = control.closest('.operation-card').querySelector('.operation-error');
    if (control.disabled || !current()) return;
    control.disabled = true;
    error.hidden = true;
    let result;
    try {
      result = await request(name,{},body);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      error.focus();
      return;
    } finally {
      control.disabled = false;
    }
    toast(typeof message==='function'?message(result):message);
    if (current()) {
      try { await refresh(false); }
      catch { toast('저장했습니다. 최신 목록은 새로고침해 확인해 주세요.'); }
      if (current()) renderOperations(view);
    }
  }
  const submit = (selector, handler)=>{
    const form = target.querySelector(selector);
    if (!form) return;
    form.onsubmit = event=>{
      event.preventDefault();
      handler(form,event.submitter || form.querySelector('button[type=submit]'));
    };
  };
  const context = {target,settings,request,save,submit,active,reload:()=>renderOperations(view)};
  try {
    await {counts:buildCounts,work:buildWork,cafe:buildCafe,planning:buildPlanning}[view](context);
  } catch (err) {
    if (active()) loading.textContent = err.message;
  }
}

async function buildCounts({target,settings,request,save,submit,active,reload}) {
  const scope = settings.scope;
  const scopeBar = `<div class="operation-switch">${[['daily','오늘 실사'],['monthly','월말 실사'],['policy','품목 설정']].map(([value,label])=>
    `<button type="button" class="button ${value===scope?'primary':'ghost'}" data-scope="${value}" aria-pressed="${value===scope}">${label}</button>`).join('')}</div>`;
  const params = {scope,date:settings.date,month:settings.countMonth};
  const data = await request(scope==='policy'?'policy':'counts',scope==='policy'?{}:params);
  if (!active()) return;
  if (scope==='policy') {
    const options = operationOptions(data,settings.policyItem);
    target.innerHTML = scopeBar+operationCard('품목별 실사 설정','기본값은 월말 확인과 장부 추적입니다.',options?`
      <form id="count-policy" class="form-grid">
        <label class="field">품목<select name="item_id" aria-label="품목">${options}</select></label>
        <label class="field">실사 주기<select name="frequency" aria-label="실사 주기"><option value="monthly">월말 확인</option><option value="daily">매일 확인</option></select></label>
        <label class="field">재고 계산<select name="mode" aria-label="재고 계산"><option value="ledger">거래 장부 추적</option><option value="snapshot">실사 기록만</option></select></label>
        <label class="field">입고 소요일(일)<input type="number" min="1" max="365" name="lead_days" placeholder="비우면 발주 후보에서 제외"></label>
        <div class="form-actions"><button class="button primary" type="submit">품목 설정 저장</button></div>
      </form>`:'<p>먼저 품목 관리에서 재고품을 추가해 주세요.</p>');
    const form = target.querySelector('#count-policy');
    if (form) {
      function showPolicy(){
        const item = data.find(i=>i.id===Number(form.elements.item_id.value));
        settings.policyItem = item.id;
        form.elements.frequency.value = item.frequency;
        form.elements.mode.value = item.mode;
        form.elements.lead_days.value = item.lead_days ?? '';
        form.elements.lead_days.disabled = item.mode==='snapshot';
      }
      form.elements.item_id.onchange = showPolicy;
      form.elements.mode.onchange = ()=>{form.elements.lead_days.disabled = form.elements.mode.value==='snapshot';};
      showPolicy();
    }
    submit('#count-policy',(form,button)=>{
      const {item_id,frequency,mode,lead_days} = form.elements;
      save(button,'policy',{item_id:Number(item_id.value),frequency:frequency.value,mode:mode.value,
        lead_days:!lead_days.disabled && lead_days.value?Number(lead_days.value):null},'품목 실사 설정을 저장했습니다.');
    });
  } else {
    const rows = data.items.map(i=>{
      const fixed = !!i.count?.finalized_mode;
      const disabled = !data.can_finalize || fixed;
      const book = fixed ? i.count.book_quantity : i.book;
      return `<tr data-count-id="${i.id}">
        <td><strong>${escapeHtml(i.name)}</strong><br><small>${i.frequency==='daily'?'매일':'월말'} · ${escapeHtml(i.unit)}</small></td>
        <td>${book===null?'':qty(book)}</td>
        <td class="count-cell"><input aria-label="${escapeHtml(i.name)} 실사 수량" type="number" min="0" max="1000000000" data-quantity
          value="${i.count?.quantity ?? ''}" ${disabled?'disabled':''}></td>
        <td data-difference></td>
        <td class="count-note"><input aria-label="${escapeHtml(i.name)} 실사 비고" data-note maxlength="300" value="${escapeHtml(i.count?.note)}" ${disabled?'disabled':''}></td>
        <td>${i.last?`${qty(i.last.quantity)} · ${i.last.report_date}`:'미조사'}</td>
        <td>${fixed?`확정 <button type="button" class="button ghost" data-reopen="${i.id}">다시 열기</button>`:
          i.count?`임시 저장 <button type="button" class="button ghost" data-clear="${i.id}">미확인으로</button>`:'미확인'}</td>
      </tr>`;
    });
    target.innerHTML = scopeBar+operationCard(scope==='daily'?'매일 확인할 품목':'월말 실사',
      '하루 업무를 마친 시점의 수량을 입력하세요. 월말에는 매일 확인 품목도 같은 날짜의 실사를 공유합니다.',`
      <div class="operation-switch">
        <label class="field">${scope==='daily'?'조사일':'조사 월'}<input id="count-period" type="${scope==='daily'?'date':'month'}" max="${scope==='daily'?today():today().slice(0,7)}"
          value="${scope==='daily'?settings.date:settings.countMonth}"></label>
        <button class="button ghost" type="button" id="count-word">재고조사표 Word 다운로드</button>
      </div>
      <p class="operation-note">기준일 ${data.date} · ${data.can_finalize?'빈 칸은 미확인으로 남고, 0은 재고 없음으로 저장됩니다.':'월말 날짜부터 실사를 저장할 수 있습니다.'}</p>
      <form id="count-form">
        ${operationTable(['품목','장부 수량','실사 수량','차이','비고','마지막 실사','상태'],rows,
          '대상 품목이 없습니다. 품목 설정에서 실사 주기를 지정할 수 있습니다.')}
        ${rows.length&&data.can_finalize?`<div class="form-actions"><button class="button ghost" type="submit" value="save">임시 저장</button>
          <button class="button primary" type="submit" value="finalize">입력한 실사 확정</button></div>`:''}
      </form>`);
    target.querySelector('#count-period').onchange = event=>{
      if (!event.target.value) return;
      if (scope==='daily') settings.date=event.target.value;
      else settings.countMonth=event.target.value;
      reload();
    };
    target.querySelector('#count-word').onclick = ()=>openStocktakeDialog(target,state.items,scope);
    const byId = new Map(data.items.map(i=>[i.id,i]));
    target.querySelectorAll('[data-count-id]').forEach(row=>{
      const item = byId.get(Number(row.dataset.countId));
      const book = item.count?.finalized_mode ? item.count.book_quantity : item.book;
      const input = row.querySelector('[data-quantity]');
      function difference(){
        const delta = input.value===''||book===null?null:Number(input.value)-book;
        row.querySelector('[data-difference]').textContent = delta===null?'':`${delta>0?'+':''}${qty(delta)}`;
      }
      input.oninput = difference;
      difference();
    });
    target.querySelectorAll('[data-reopen]').forEach(button=>button.onclick=()=>{
      if (confirm('실사를 다시 열면 이 실사에서 만든 장부 조정이 취소됩니다. 계속할까요?')) {
        save(button,'counts',{...params,action:'reopen',entries:[{item_id:Number(button.dataset.reopen)}]},'실사를 다시 열었습니다.');
      }
    });
    target.querySelectorAll('[data-clear]').forEach(button=>button.onclick=()=>{
      save(button,'counts',{...params,action:'clear',entries:[{item_id:Number(button.dataset.clear)}]},'미확인으로 되돌렸습니다.');
    });
    submit('#count-form',(form,button)=>{
      const entries = [...form.querySelectorAll('[data-count-id]')].flatMap(row=>{
        const input = row.querySelector('[data-quantity]');
        if (input.disabled || input.value==='') return [];
        const item = byId.get(Number(row.dataset.countId));
        return [{item_id:item.id,quantity:Number(input.value),note:row.querySelector('[data-note]').value,book:item.book}];
      });
      if (!entries.length) return toast('실사 수량을 입력해 주세요.');
      const action = button.value;
      if (action==='finalize' && !confirm(`${entries.length}개 품목의 실사를 확정할까요? 장부 추적 품목은 차이만 반영합니다.`)) return;
      save(button,'counts',{...params,action,entries},action==='finalize'?'실사를 확정했습니다.':'실사 수량을 임시 저장했습니다.');
    });
  }
  target.querySelectorAll('[data-scope]').forEach(button=>button.onclick=()=>{
    settings.scope=button.dataset.scope;
    if (settings.scope==='daily') settings.date=today();
    reload();
  });
}

async function buildWork({target,settings,request,save,submit,active,reload}) {
  const [logs,production] = await Promise.all([
    request('work',{month:settings.workMonth}),api('/api/production'),
  ]);
  if (!active()) return;
  const items = state.items.filter(i=>i.item_type==='STOCK');
  const workItems = items.filter(i=>i.stock_mode!=='snapshot');
  const byId = new Map(items.map(i=>[i.id,i]));
  const token = productionToken();
  const rows = logs.map(log=>`<tr>
    <td>${log.work_date}</td><td><strong>${escapeHtml(log.name)}</strong></td><td>${qty(log.workers)}명 / ${qty(log.person_minutes)}분</td>
    <td>${qty(log.quantity)} ${escapeHtml(log.unit)}</td><td>${qty(log.defective)}</td>
    <td>${escapeHtml(log.note)}</td><td>${log.status==='posted'?'재고 반영':log.status==='recorded'?'실적 기록':'확인 필요'}
      ${log.issue?`<br><small>${escapeHtml(log.issue)}</small>`:''}
      ${log.status==='pending'?`<br><button class="button ghost" type="button" data-work-retry="${log.id}">재고 다시 반영</button>`:''}</td></tr>`);
  target.innerHTML = operationCard('작업 실적 입력','작업일지는 한 번만 입력합니다. 재료가 부족해도 실적을 저장하고 재고 반영은 보류합니다.',`
    <div class="operation-switch"><button class="button ghost" type="button" onclick="setView('production')">완성품·재료 구성 관리</button></div>
    ${workItems.length?`<form id="work-form">
      <div class="form-grid three">
        <label class="field">작업일<input type="date" name="work_date" value="${today()}" max="${today()}" required></label>
        <label class="field">작업 품목<select name="item_id" aria-label="작업 품목" required><option value="">선택하세요</option>${operationOptions(workItems)}</select></label>
        <label class="field">참여 인원<input type="number" name="workers" min="1" max="10000" required></label>
        <label class="field">1인 작업시간(분)<input type="number" name="minutes" min="1" max="1440" required></label>
        <label class="field">전체 참여 시간(분) 직접 입력<input type="number" name="person_minutes" min="1" max="10000000" placeholder="참여자별 시간이 다를 때만"></label>
        <label class="field">정상 완성 수량<input type="number" name="quantity" min="0" max="1000000000" required></label>
        <label class="field">불량 수량<input type="number" name="defective" min="0" max="1000000000" value="0"></label>
        <label class="field">작업 비고<input name="note" maxlength="300"></label>
      </div>
      <p class="operation-note" id="work-total"></p>
      <details><summary>실제 재료 사용량이 배합표와 다를 때</summary><div id="work-materials"></div></details>
      <div class="form-actions"><button class="button primary" type="submit">작업일지 저장</button></div>
    </form>`:'<p>먼저 작업 품목을 등록해 주세요.</p>'}`)+
    operationCard('작업일지 내역','생산 실적과 재고 반영 상태를 월별로 확인합니다.',`
      <label class="field">조회 월<input type="month" id="work-period" max="${today().slice(0,7)}" value="${settings.workMonth}"></label>
      ${operationTable(['작업일','품목','인원 / 전체 참여 시간','정상 완성','불량','비고','재고 상태'],rows,'이달 작업 기록이 없습니다.')}`);
  const form = target.querySelector('#work-form');
  if (form) {
    function showTotal(){
      const {workers,minutes,person_minutes} = form.elements;
      minutes.required = !person_minutes.value;
      const total = Number(person_minutes.value) || Number(workers.value)*Number(minutes.value);
      form.querySelector('#work-total').textContent = total?`전체 참여 시간 ${qty(total)}분`:'';
    }
    function showMaterials(){
      const recipe = production.recipes[form.elements.item_id.value] || [];
      form.querySelector('#work-materials').innerHTML = recipe.length?recipe.map(part=>{
        const item = byId.get(part.item_id);
        return `<label class="field">${escapeHtml(item?.name || '사용 중지 재료')} (${escapeHtml(item?.unit)})
          <input type="number" min="0" max="1000000000" data-used="${part.item_id}" placeholder="빈 칸은 완성품 1개당 ${part.quantity} 사용"></label>`;
      }).join(''):'<p class="operation-note">재료 구성이 등록되어 있지 않습니다.</p>';
    }
    form.elements.item_id.onchange = showMaterials;
    form.oninput = showTotal;
    showMaterials();
  }
  submit('#work-form',(form,button)=>{
    const f=form.elements;
    const workDate=f.work_date.value;
    const usage=Object.fromEntries([...form.querySelectorAll('[data-used]')].filter(input=>input.value!=='').map(input=>[input.dataset.used,Number(input.value)]));
    save(button,'work',{action:'save',id:token,work_date:workDate,item_id:Number(f.item_id.value),workers:Number(f.workers.value),
      person_minutes:Number(f.person_minutes.value)||Number(f.workers.value)*Number(f.minutes.value),quantity:Number(f.quantity.value),
      defective:Number(f.defective.value),note:f.note.value,usage},result=>{
        settings.workMonth=workDate.slice(0,7);
        return result.status==='pending'?'작업일지 저장 · 재고 반영 확인 필요':'작업일지를 저장했습니다.';
      });
  });
  target.querySelector('#work-period').onchange = event=>{
    if (event.target.value) {settings.workMonth=event.target.value;reload();}
  };
  target.querySelectorAll('[data-work-retry]').forEach(button=>button.onclick=()=>save(button,'work',{
    action:'retry',id:button.dataset.workRetry,
  },result=>result.status==='posted'?'재료와 완성품 재고를 반영했습니다.':'아직 재고 반영이 보류 중입니다.'));
}

async function buildCafe({target,settings,request,save,submit,active}) {
  const data = await request('cafe');
  if (!active()) return;
  const materials = state.items.filter(i=>i.item_type==='STOCK' && i.stock_mode!=='snapshot');
  const token = productionToken();
  target.innerHTML = operationCard('판매당 재료 사용량','거래 입력에서 판매를 저장하면 레시피 수량만큼 차감합니다. 주문 즉시 만드는 메뉴는 용역·서비스로 등록하면 메뉴 자체의 재고를 관리할 필요가 없습니다.',`
    <form id="cafe-form">
      <label class="field">판매 메뉴<select name="menu_id" aria-label="판매 메뉴" required><option value="">선택하세요</option>${operationOptions(state.items,settings.menu)}</select></label>
      <div id="cafe-components"></div>
      <div class="form-actions"><button type="button" class="button ghost" data-cafe-add>＋ 재료</button><button type="submit" class="button primary">레시피 저장</button></div>
    </form>
    <p class="operation-note">원두는 g, 우유는 mL처럼 수량을 정수로 입력할 수 있는 단위를 사용하세요. 저장한 레시피는 이후 거래 입력부터 적용됩니다.</p>`)+
    operationCard('폐기 기록','신선식품 등 실제 버린 양을 기록합니다. 마감 실사 전에 폐기를 입력하면 실사 조정에서 같은 수량이 다시 빠지지 않습니다.',`
      <form id="waste-form"><div class="form-grid three">
        <label class="field">폐기일<input type="date" name="date" max="${today()}" value="${today()}" required></label>
        <label class="field">재료<select name="item_id" required><option value="">선택하세요</option>${operationOptions(materials)}</select></label>
        <label class="field">폐기 수량<input type="number" name="quantity" min="1" max="1000000000" required></label>
        <label class="field">사유<input name="note" maxlength="300" placeholder="예: 마감 후 폐기"></label>
      </div><div class="form-actions"><button type="submit" class="button primary">폐기 저장</button></div></form>`);
  const form=target.querySelector('#cafe-form');
  const list=form.querySelector('#cafe-components');
  function add(part={}){
    const menu=Number(form.elements.menu_id.value);
    const row=document.createElement('div');
    row.className='operation-line';
    row.innerHTML=`<label class="field">재료<select data-item aria-label="재료" required><option value="">선택하세요</option>${operationOptions(materials.filter(i=>i.id!==menu),part.item_id)}</select></label>
      <label class="field">판매 1개당 사용량<input type="number" min="1" max="1000000000" data-used value="${part.quantity ?? ''}" required></label>
      <button type="button" class="button danger">빼기</button>`;
    row.querySelector('button').onclick=()=>row.remove();
    list.append(row);
  }
  function menuChanged(){
    settings.menu=Number(form.elements.menu_id.value);
    list.replaceChildren();
    data.recipes.filter(part=>part.menu_id===settings.menu).forEach(add);
    form.querySelector('[data-cafe-add]').disabled=!settings.menu;
  }
  form.elements.menu_id.onchange=menuChanged;
  form.querySelector('[data-cafe-add]').onclick=()=>add();
  menuChanged();
  submit('#cafe-form',(form,button)=>{
    const components=[...list.children].map(row=>({item_id:Number(row.querySelector('[data-item]').value),quantity:Number(row.querySelector('[data-used]').value)}));
    if (!components.length && !confirm('이 메뉴의 레시피를 비우고 자동 재료 차감을 해제할까요?')) return;
    save(button,'cafe',{menu_id:settings.menu,components},'레시피를 저장했습니다.');
  });
  submit('#waste-form',(form,button)=>{
    const f=form.elements;
    save(button,'waste',{id:token,date:f.date.value,item_id:Number(f.item_id.value),quantity:Number(f.quantity.value),note:f.note.value},
      result=>result.stock<0?'폐기 저장 · 장부 재고를 확인해 주세요.':'폐기를 기록했습니다.');
  });
}

async function buildPlanning({target,settings,request,save,submit,active,reload}) {
  const [data,capacity] = await Promise.all([request('buying'),
    productionEnabled()?request('capacity',{month:settings.capacityMonth}):Promise.resolve(null)]);
  if (!active()) return;
  const items = state.items.filter(i=>i.item_type==='STOCK'&&i.stock_mode!=='snapshot');
  const token = productionToken();
  const forecast = data.items.map(i=>`<tr><td><strong>${escapeHtml(i.name)}</strong> (${escapeHtml(i.unit)})</td>
    <td>${qty(i.stock)}</td><td>${i.days?`${qty(i.daily_usage)} / ${i.days}일`:'관측 자료 없음'}${i.skipped?`<br><small>재고 0 이하·사용 기록 없음 ${i.skipped}일 제외</small>`:''}</td><td>${i.lead_days}일</td><td>${qty(i.incoming)}</td>
    <td>${i.short_date||'—'}</td><td>${i.order_by===today()?'오늘 검토':i.order_by||'—'}</td>
    <td>${i.suggested?`<strong>${qty(i.suggested)}</strong>`:'—'}</td></tr>`);
  const orders = data.orders.map(order=>`<tr><td>${escapeHtml(order.name)}</td><td>${qty(order.quantity)} ${escapeHtml(order.unit)}</td>
    <td>${order.due_date} ${order.due_date<today()?'· 지연':''}</td><td>${escapeHtml(order.note)}</td>
    <td><button type="button" class="button ghost" data-receive="${order.id}">입고 처리</button>
    <button type="button" class="button danger" data-cancel-order="${order.id}">발주 취소</button></td></tr>`);
  target.innerHTML = operationCard('발주 후보','최근 최대 28일의 판매·불출·생산 사용·레시피 사용·폐기를 바탕으로 계산합니다. 최소재고는 입고 시점의 여유분으로 반영합니다.',`
    <div><button class="button ghost" type="button" data-planning-policy>입고 소요일 설정</button></div>
    ${operationTable(['품목','오늘 장부','하루 평균 / 관측 기간','입고 소요일','기간 내 입고 예정','예상 부족일','권장 발주일','지금 권장 수량'],forecast,
      '실사 품목 설정에서 입고 소요일을 지정하면 발주 후보가 표시됩니다.')}
    <p class="operation-note">예상 수량은 참고용입니다. 판매가 끊긴 날이나 예약 생산, 실제 사용 가능한 신선식품 수량은 주문 전에 확인하세요.</p>`)+
    operationCard('입고 예정','발주 등록 후 실제 물품을 받으면 입고 처리하세요. 장부에 매입이 한 번 생성됩니다.',`
      <form id="order-form"><div class="form-grid three">
        <label class="field">품목<select name="item_id" aria-label="품목" required><option value="">선택하세요</option>${operationOptions(items)}</select></label>
        <label class="field">입고 예정일<input type="date" name="due_date" value="${today()}" required></label>
        <label class="field">예정 수량<input type="number" name="quantity" min="1" max="1000000000" required></label>
        <label class="field">비고<input name="note" maxlength="300"></label>
      </div><div class="form-actions"><button type="submit" class="button primary">발주 등록</button></div></form>
      ${operationTable(['품목','수량','예정일','비고','관리'],orders,'미입고 발주가 없습니다.')}
      <form id="receive-form" hidden><input type="hidden" name="id"><p class="operation-note" data-receive-label></p><div class="form-grid">
        <label class="field">실제 입고일<input type="date" name="date" max="${today()}" value="${today()}" required></label>
        <label class="field">입고 단가(원)<input type="number" name="unit_price" min="0" max="1000000000" value="0" required></label>
      </div><div class="form-actions"><button type="button" class="button ghost" data-close-receive>닫기</button>
        <button type="submit" class="button primary">매입으로 반영</button></div></form>`);
  target.querySelector('[data-planning-policy]').onclick = ()=>{settings.scope='policy';setView('counts');};
  submit('#order-form',(form,button)=>{
    const f=form.elements;
    save(button,'buying',{action:'add',id:token,item_id:Number(f.item_id.value),due_date:f.due_date.value,
      quantity:Number(f.quantity.value),note:f.note.value},'입고 예정에 등록했습니다.');
  });
  target.querySelectorAll('[data-cancel-order]').forEach(button=>button.onclick=()=>{
    if (confirm('이 발주를 취소할까요?')) save(button,'buying',{action:'cancel',id:button.dataset.cancelOrder},'발주를 취소했습니다.');
  });
  const receive = target.querySelector('#receive-form');
  target.querySelectorAll('[data-receive]').forEach(button=>button.onclick=()=>{
    const order=data.orders.find(o=>o.id===button.dataset.receive);
    receive.elements.id.value=order.id;
    receive.elements.unit_price.value=state.items.find(i=>i.id===order.item_id)?.unit_price ?? 0;
    receive.querySelector('[data-receive-label]').textContent=`${order.name} ${qty(order.quantity)} ${order.unit} 입고`;
    receive.hidden=false;
    receive.elements.date.focus();
  });
  receive.querySelector('[data-close-receive]').onclick=()=>{receive.hidden=true;};
  submit('#receive-form',(form,button)=>{
    const f=form.elements;
    save(button,'buying',{action:'receive',id:f.id.value,date:f.date.value,unit_price:Number(f.unit_price.value)},'발주를 매입으로 반영했습니다.');
  });
  if (capacity===null) return;
  const rows = capacity.map(i=>`<tr><td><strong>${escapeHtml(i.name)}</strong></td><td>${i.days}일</td>
    <td>${qty(i.quantity)} ${escapeHtml(i.unit)}</td><td>${qty(i.defective)}</td><td>${qty(i.person_minutes)}분</td>
    <td>${qty(i.hourly)} ${escapeHtml(i.unit)}</td><td>${i.pending}건</td></tr>`);
  target.insertAdjacentHTML('beforeend',operationCard('품목별 생산능력','작업일지의 정상 완성 수량과 전체 참여 시간을 집계합니다. 재고 반영 보류 작업도 실적에 포함합니다.',`
    <label class="field">조회 월<input type="month" id="capacity-period" max="${today().slice(0,7)}" value="${settings.capacityMonth}"></label>
    ${operationTable(['품목','작업일','정상 완성','불량','전체 참여 시간','1인·시간당','재고 보류'],rows,'이달 작업일지를 작성하면 생산 실적이 표시됩니다.')}
    ${capacity.length?`<div class="form-grid">
      <label class="field">계획 품목<select id="capacity-item">${capacity.map(i=>`<option value="${i.item_id}">${escapeHtml(i.name)}</option>`).join('')}</select></label>
      <label class="field">계획 참여 인원<input id="capacity-people" type="number" min="1" value="1"></label>
      <label class="field">1인당 총 작업시간(시간)<input id="capacity-hours" type="number" min="0" step="0.5" value="8"></label>
      <label class="field">이미 잡힌 생산량<input id="capacity-booked" type="number" min="0" value="0"></label>
    </div><output id="capacity-output"></output>`:''}`));
  target.querySelector('#capacity-period').onchange=event=>{
    if (event.target.value) {settings.capacityMonth=event.target.value;reload();}
  };
  if (!capacity.length) return;
  function calculate(){
    const item=capacity.find(i=>i.item_id===Number(target.querySelector('#capacity-item').value));
    const number=id=>Math.max(0,Number(target.querySelector(id).value));
    const output=target.querySelector('#capacity-output');
    const labor=Math.floor(item.typical*number('#capacity-people')*number('#capacity-hours'));
    const booked=number('#capacity-booked');
    const additional=Math.max(0,Math.min(labor,item.material_limit ?? Infinity)-booked);
    output.textContent=`인력 기준 ${qty(labor)} · 재료 기준 ${item.material_limit===null?'재료 구성 미등록':qty(item.material_limit)} · ${item.material_limit===null?'인력만 고려한 추가 예상':'추가 대응 예상'} ${qty(additional)} ${item.unit}${item.days<5?' · 작업일 표본 5일 미만':''}`;
  }
  ['#capacity-item','#capacity-people','#capacity-hours','#capacity-booked'].forEach(id=>target.querySelector(id).oninput=calculate);
  calculate();
}
