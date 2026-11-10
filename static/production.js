const selectedProduction = new Map();

function productionEnabled() {
  return state.businesses.some(b=>b.id===state.businessId && b.production_enabled);
}

function isProductionMovement(row) {
  return row.source?.startsWith('production:');
}

function managedMovement(row) {
  return isProductionMovement(row) || ['count:','cafe:','order:'].some(prefix=>row.source?.startsWith(prefix));
}

function transactionLabel(row) {
  if (isProductionMovement(row)) return row.transaction_type==='ADJUST_IN' ? '생산 입고' : '생산 출고';
  if (row.source?.startsWith('count:')) return '실사 조정';
  if (row.source?.startsWith('cafe:')) return '레시피 사용';
  if (row.source?.startsWith('order:')) return '발주 입고';
  if (row.source?.startsWith('waste:')) return '폐기';
  return labels[row.transaction_type] || row.transaction_type;
}

function productionToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte=>byte.toString(16).padStart(2,'0')).join('');
}

async function renderProduction() {
  if (!productionEnabled()) return setView('ledger');
  const business = state.businessId;
  const target = $('#view-production');
  target.innerHTML = '<div class="card empty">생산 기록을 불러오는 중입니다…</div>';
  const loading = target.firstElementChild;
  try {
    const data = await api('/api/production');
    if (!loading.isConnected || state.businessId!==business || state.view!=='production') return;
    buildProduction(target, data, business);
  } catch (err) {
    if (loading.isConnected) loading.textContent = err.message;
  }
}

function buildProduction(target, data, business) {
  const items = state.items.filter(item=>item.item_type==='STOCK' && item.stock_mode!=='snapshot');
  const byId = new Map(items.map(item=>[item.id,item]));
  const optionList = (selected, excluded)=>items.filter(item=>item.id!==excluded).map(item=>
    `<option value="${item.id}" ${item.id===selected?'selected':''}>${escapeHtml(item.name)} (${escapeHtml(item.unit)})</option>`
  ).join('');
  const history = data.batches.map(batch=>{
    const {finished, movements, note} = batch.details;
    return `<details class="production-history">
      <summary>${escapeHtml(batch.produced_date)} · <strong>${escapeHtml(finished.name)} ${qty(batch.quantity)} ${escapeHtml(finished.unit)} 생산</strong></summary>
      ${note?`<p>${escapeHtml(note)}</p>`:''}
      <ul>${movements.map(move=>`<li>${escapeHtml(move.action)} · ${escapeHtml(move.name)} <strong>${move.delta>0?'+':'−'}${qty(Math.abs(move.delta))} ${escapeHtml(move.unit)}</strong></li>`).join('')}</ul>
    </details>`;
  }).join('');
  target.innerHTML = `
    <button type="button" class="button ghost section" onclick="setView('ledger')">← 거래 장부</button>
    <button type="button" class="button ghost section" onclick="setView('work')">작업일지</button>
    <div class="card section">
      <div class="card-head"><div><h2>완성품 선택</h2><small>생산을 저장하면 재료가 차감되고 완성품이 입고됩니다.</small></div></div>
      <div class="card-body"><div class="field"><label for="production-finished">완성품</label>
        <select id="production-finished"><option value="">완성품을 선택해 주세요</option>${optionList(selectedProduction.get(business))}</select>
      </div></div>
    </div>
    <div id="production-editor"></div>
    <div class="card"><div class="card-head"><div><h2>최근 생산 기록</h2><small>생산 건을 열어 재료와 완성품의 재고 변동을 확인할 수 있습니다.</small></div></div>
      <div class="card-body">${history||'<p>아직 생산 기록이 없습니다.</p>'}</div></div>`;
  const select = target.querySelector('#production-finished');
  const editor = target.querySelector('#production-editor');
  const options = {headers:{'X-Business-ID':business}};
  let saving = false;

  function draw() {
    const finishedId = Number(select.value);
    selectedProduction.set(business, finishedId);
    const finished = byId.get(finishedId);
    if (!finished) { editor.replaceChildren(); return; }
    const saved = data.recipes[finishedId] || [];
    editor.innerHTML = `
      <div class="card section">
        <div class="card-head"><h2>생산 등록</h2></div>
        <form id="production-batch-form" class="card-body">
          <p class="production-message" role="alert" hidden></p>
          <div class="form-grid">
            <label class="field">생산 수량 (${escapeHtml(finished.unit)})<input type="number" name="quantity" min="1" max="1000000000" value="1" required></label>
            <label class="field">비고<input name="note" maxlength="300"></label>
          </div>
          <div class="production-preview"></div>
          <div class="form-actions"><button class="button primary" ${saved.length?'':'disabled'}>생산 기록 저장</button></div>
        </form>
      </div>
      <details class="card section production-recipe" ${saved.length?'':'open'}>
        <summary class="card-head"><strong>완성품 1개당 재료 구성</strong></summary>
        <form id="production-recipe-form" class="card-body">
          <p>포대 환산이 필요한 재료는 품목 관리에서 포대와 낱개를 각각 등록한 뒤 아래에서 연결하세요. 남은 낱개부터 사용하고 부족할 때만 포장을 개봉합니다.</p>
          <p class="production-message" role="alert" hidden></p>
          <div class="production-components"></div>
          <div class="form-actions"><button type="button" class="button ghost" data-add-component>＋ 재료 추가</button><button class="button primary">재료 구성 저장</button></div>
        </form>
      </details>`;
    const recipe = editor.querySelector('#production-recipe-form');
    const batch = editor.querySelector('#production-batch-form');
    const components = recipe.querySelector('.production-components');
    const preview = batch.querySelector('.production-preview');
    let pendingKey = '';
    let pendingToken = '';

    function addComponent(row={}) {
      components.insertAdjacentHTML('beforeend', `<div class="production-component">
        <label class="field">재료 품목<select name="material" required><option value="">재료 선택</option>${optionList(row.item_id,finishedId)}</select></label>
        <label class="field">1개당 필요 수량<input type="number" name="required_quantity" min="1" max="1000000000" value="${row.quantity||1}" required></label>
        <label class="field">포장 품목<select name="package"><option value="">포장 환산 없음</option>${optionList(row.package_id,finishedId)}</select></label>
        <label class="field">포장 하나당 낱개 수량<input type="number" name="package_size" min="1" max="1000000000" value="${row.package_size||''}" ${row.package_id?'required':'disabled'}></label>
        <button type="button" class="button danger" data-remove-component>빼기</button>
      </div>`);
      const element = components.lastElementChild;
      element.querySelector('[name=package]').onchange = event=>{
        const size = element.querySelector('[name=package_size]');
        size.disabled = !event.target.value;
        size.required = !size.disabled;
      };
      element.querySelector('[data-remove-component]').onclick = ()=>{
        if (components.children.length>1) element.remove();
      };
    }
    if (saved.length) saved.forEach(addComponent); else addComponent();
    recipe.querySelector('[data-add-component]').onclick = ()=>addComponent();

    function drawPreview() {
      const quantity = Number(batch.elements.quantity.value);
      if (!saved.length) { preview.textContent = '재료 구성을 먼저 저장해 주세요.'; return; }
      preview.innerHTML = '<ul>'+saved.map(row=>{
        const item = byId.get(row.item_id);
        const pack = byId.get(row.package_id);
        if (!item) return '<li>사용중지된 재료가 있습니다. 구성을 수정해 주세요.</li>';
        const amount = quantity * row.quantity;
        const opened = pack ? Math.max(0,Math.ceil((amount-item.stock)/row.package_size)) : 0;
        const conversion = pack ? (opened>pack.stock
          ? ` · ${escapeHtml(pack.name)} 재고 부족`
          : ` · 개봉 ${qty(opened)} ${escapeHtml(pack.unit)}, 생산 후 ${qty(pack.stock-opened)} ${escapeHtml(pack.unit)} + 낱개 ${qty(item.stock+opened*row.package_size-amount)} ${escapeHtml(item.unit)} 예상`) : '';
        return `<li><strong>${escapeHtml(item.name)}</strong> ${qty(amount)} ${escapeHtml(item.unit)} 사용 · 낱개 재고 ${qty(item.stock)} ${escapeHtml(item.unit)}${conversion}</li>`;
      }).join('')+'</ul>';
    }
    batch.elements.quantity.oninput = drawPreview;
    drawPreview();

    async function submit(form, path, payload) {
      if (saving) return false;
      saving = true;
      const error = form.querySelector('[role=alert]');
      const controls = [...editor.querySelectorAll('button'), select];
      const previous = controls.map(control=>control.disabled);
      controls.forEach(control=>{control.disabled=true});
      error.hidden = true;
      try {
        await api(path, {...options, method:'POST', body:JSON.stringify(payload)});
        return true;
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        return false;
      } finally {
        saving = false;
        controls.forEach((control,i)=>{control.disabled=previous[i]});
      }
    }
    recipe.onsubmit = async event=>{
      event.preventDefault();
      const rows = [...components.children].map(row=>{
        const packageId = Number(row.querySelector('[name=package]').value);
        return {
          item_id:Number(row.querySelector('[name=material]').value),
          quantity:Number(row.querySelector('[name=required_quantity]').value),
          package_id:packageId||null,
          package_size:packageId ? Number(row.querySelector('[name=package_size]').value) : null,
        };
      });
      if (await submit(recipe,'/api/production/recipe',{finished_id:finishedId,components:rows})) {
        toast('재료 구성을 저장했습니다.');
        if (state.view==='production' && state.businessId===business) renderProduction();
      }
    };
    batch.onsubmit = async event=>{
      event.preventDefault();
      const payload = {finished_id:finishedId,quantity:Number(batch.elements.quantity.value),note:batch.elements.note.value.trim()};
      const key = JSON.stringify(payload);
      if (key!==pendingKey) { pendingKey=key; pendingToken=productionToken(); }
      if (await submit(batch,'/api/production/batch',{...payload,request_id:pendingToken})) {
        toast('생산을 저장했습니다.');
        if (state.view==='production' && state.businessId===business) {
          try { await refresh(); }
          catch { toast('저장은 완료됐습니다. 목록을 확인하려면 새로고침해 주세요.'); }
        }
      }
    };
  }
  select.onchange = draw;
  draw();
}
